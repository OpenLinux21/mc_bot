const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock, GoalXZ, GoalY, GoalInvert, GoalFollow } = goals;

// 错误日志写入
const errorLogPath = path.join(__dirname, 'error.log');

function logError(error) {
    const timestamp = getTimestamp();
    const logEntry = `[${timestamp}] ${error.stack || error}\n`;
    fs.appendFileSync(errorLogPath, logEntry);
}

// 清除上次的错误日志
try {
    fs.writeFileSync(errorLogPath, '');
} catch (error) {
    console.error('清除错误日志失败:', error);
}

// ANSI颜色代码
const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    white: '\x1b[37m',
    reset: '\x1b[0m',
    bold: '\x1b[1m'
};

// 配置对象和全局变量
let config = {};
let bot;
let reconnectInterval;
let rl;
let commandHistory = [];
let historyIndex = -1;
let knownPlayers = new Set();
let movementTimer;
let movementStartTime;
let isMoving = false;
let startTime;
let gui;
let followingPlayer = null;
let followingInterval = null;

// 读取配置文件
function readConfig() {
    try {
        const configPath = path.join(__dirname, 'config.txt');
        const configContent = fs.readFileSync(configPath, 'utf8');
        
        config = {};
        configContent.split('\n').forEach(line => {
            line = line.trim();
            if (line && !line.startsWith('#')) {
                const [key, ...valueParts] = line.split('=');
                if (key && valueParts.length > 0) {
                    config[key.trim()] = valueParts.join('=').trim();
                }
            }
        });
        
        console.log(colors.blue + '配置加载成功:' + colors.reset);
        console.log(`服务器地址: ${config.server_address}`);
        console.log(`服务器版本: ${config.server_version}`);
        console.log(`用户名: ${config.username}`);
        console.log(`初始命令: ${config.init_command}`);
        console.log('');
        
        return true;
    } catch (error) {
        console.error(colors.red + 'Error reading config.txt:' + colors.reset, error.message);
        return false;
    }
}

// 获取时间戳
function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// 移除Minecraft颜色代码
function removeColorCodes(text) {
    return text.toString().replace(/§[0-9a-fk-or]/g, '');
}

// 获取在线时间
function getOnlineTime() {
    if (!startTime) return '未知';
    const now = Date.now();
    const onlineMs = now - startTime;
    const hours = Math.floor(onlineMs / (1000 * 60 * 60));
    const minutes = Math.floor((onlineMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((onlineMs % (1000 * 60)) / 1000);
    return `${hours}小时${minutes}分钟${seconds}秒`;
}

// 安全输出（不干扰输入行）
function safeLog(message) {
    if (rl) {
        // 保存当前输入状态
        const currentLine = rl.line;
        const currentCursor = rl.cursor;
        
        // 移动到行首并清除
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        
        // 输出消息
        console.log(message);
        
        // 恢复提示符和之前的输入
        process.stdout.write(colors.cyan + '[Bot] > ' + colors.reset + currentLine);
        
        // 恢复光标位置
        if (currentCursor < currentLine.length) {
            readline.cursorTo(process.stdout, 8 + currentCursor); // 8 是提示符长度
        }
    } else {
        console.log(message);
    }
}

// 创建交互式终端
function createInteractiveTerminal() {
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: colors.cyan + '[Bot] > ' + colors.reset,
        completer: completer
    });

    // 启用历史记录
    rl.history = commandHistory;

    rl.on('line', (input) => {
        const trimmedInput = input.trim();
        
        if (trimmedInput === '') {
            rl.prompt();
            return;
        }

        // 添加到历史记录
        if (commandHistory[commandHistory.length - 1] !== trimmedInput) {
            commandHistory.push(trimmedInput);
            if (commandHistory.length > 100) {
                commandHistory.shift();
            }
        }
        historyIndex = commandHistory.length;

        // 处理内置命令
        if (trimmedInput.startsWith('.')) {
            handleBuiltinCommand(trimmedInput);
        } else {
            // 发送到Minecraft聊天
            if (bot && bot.entity) {
                bot.chat(trimmedInput);
                safeLog(colors.yellow + `[${getTimestamp()}] [发送] ${trimmedInput}` + colors.reset);
            } else {
                safeLog(colors.red + `[${getTimestamp()}] 错误: Bot未连接到服务器` + colors.reset);
            }
        }
        
        rl.prompt();
    });

    // 处理Ctrl+C
    rl.on('SIGINT', () => {
        safeLog(colors.yellow + `\n[${getTimestamp()}] 正在退出...` + colors.reset);
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
        }
        if (movementTimer) {
            clearInterval(movementTimer);
        }
        if (bot) {
            bot.quit();
        }
        process.exit(0);
    });

    rl.prompt();
}

// 自动补全功能
function completer(line) {
    const hits = [];
    
    // 内置命令补全
    const builtinCommands = ['.help', '.where', '.time', '.find', '.find_block', '.go', '.hand', '.info', '.open', '.chest', '.inv'];
    const builtinHits = builtinCommands.filter(cmd => cmd.startsWith(line));
    hits.push(...builtinHits);
    
    // .hand 命令的参数补全
    if (line.startsWith('.hand ')) {
        const handArgs = ['info', 'use', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
        const parts = line.split(' ');
        if (parts.length === 2) {
            const handHits = handArgs.filter(arg => arg.startsWith(parts[1]))
                .map(arg => '.hand ' + arg);
            hits.push(...handHits);
        } else if (parts.length === 3 && parts[1] === 'use') {
            const useArgs = ['A', 'B'];
            const useHits = useArgs.filter(arg => arg.startsWith(parts[2]))
                .map(arg => '.hand use ' + arg);
            hits.push(...useHits);
        }
    }
    
    // .open 命令的参数补全
    if (line.startsWith('.open ')) {
        const parts = line.split(' ');
        if (parts.length === 3) {
            const actionArgs = ['A', 'B'];
            const actionHits = actionArgs.filter(arg => arg.startsWith(parts[2]))
                .map(arg => '.open ' + parts[1] + ' ' + arg);
            hits.push(...actionHits);
        }
    }
    
    // Minecraft命令补全
    if (line.startsWith('/')) {
        const mcCommands = ['/help', '/list', '/msg', '/tell', '/w', '/r', '/home', '/spawn', '/tp', '/gamemode'];
        const mcHits = mcCommands.filter(cmd => cmd.startsWith(line));
        hits.push(...mcHits);
    }
    
    // 玩家名补全
    if (line.includes(' ') && (line.startsWith('/msg ') || line.startsWith('/tell ') || line.startsWith('/w '))) {
        const parts = line.split(' ');
        if (parts.length === 2) {
            const playerHits = Array.from(knownPlayers).filter(player => 
                player.toLowerCase().startsWith(parts[1].toLowerCase())
            ).map(player => parts[0] + ' ' + player);
            hits.push(...playerHits);
        }
    }
    
    return [hits, line];
}

// 寻路进度报告
function startMovementProgress(targetPos) {
    if (movementTimer) {
        clearInterval(movementTimer);
    }
    
    movementStartTime = Date.now();
    isMoving = true;
    
    movementTimer = setInterval(() => {
        if (!bot || !bot.entity || !isMoving) {
            clearInterval(movementTimer);
            return;
        }
        
        const currentPos = bot.entity.position;
        const distance = currentPos.distanceTo(targetPos);
        const timeElapsed = (Date.now() - movementStartTime) / 1000;
        
        // 计算速度和ETA
        const initialDistance = bot.initialDistance || distance;
        const distanceTraveled = initialDistance - distance;
        const speed = distanceTraveled / timeElapsed;
        const eta = speed > 0 ? (distance / speed) : 0;
        
        safeLog(colors.blue + `[${getTimestamp()}] 移动进度: 距离=${distance.toFixed(2)}方块, 速度=${speed.toFixed(2)}方块/秒, ETA=${eta.toFixed(0)}秒` + colors.reset);
    }, 10000); // 每10秒报告一次
}

// 停止移动进度报告
function stopMovementProgress() {
    if (movementTimer) {
        clearInterval(movementTimer);
        movementTimer = null;
    }
    isMoving = false;
}

// 停止所有移动相关任务
function stopAllMovement() {
    if (bot && bot.pathfinder) {
        bot.pathfinder.setGoal(null);
    }
    stopMovementProgress();
    if (followingInterval) {
        clearInterval(followingInterval);
        followingInterval = null;
    }
    followingPlayer = null;
    isMoving = false;
}

// 处理内置命令
function handleBuiltinCommand(command) {
    const parts = command.split(' ');
    const cmd = parts[0];
    
    switch (cmd) {
        case '.help':
            safeLog(colors.cyan + '内置命令帮助:' + colors.reset);
            safeLog('  .help          - 显示此帮助信息');
            safeLog('  .where         - 显示机器人当前坐标');
            safeLog('  .time          - 显示服务器时间刻');
            safeLog('  .find          - 显示可见范围内的玩家坐标');
            safeLog('  .find_block <方块名> - 查找指定方块');
            safeLog('  .go <x> <y> <z> - 向指定坐标移动（使用寻路）');
            safeLog('  .go stop       - 停止当前寻路任务');
            safeLog('  .hunt <玩家名> - 自动跟随指定玩家');
            safeLog('  .hunt stop     - 停止跟随玩家');
            safeLog('  .hand info     - 查看所有物品栏信息');
            safeLog('  .hand <0-9>    - 切换到指定物品栏槽位');
            safeLog('  .hand use <A/B> - 执行动作（A=左键，B=右键）');
            safeLog('  .info          - 显示bot状态信息');
            safeLog('  .open <方块名> <A/B> - 寻找并操作指定方块');
            safeLog('  .chest         - 查看当前打开的箱子内容');
            safeLog('  .inv           - 查看完整背包内容');
            safeLog('  .exit          - 断开连接并退出程序');
            safeLog('');
            safeLog(colors.yellow + '提示: 直接输入文本发送到聊天，输入/命令执行MC命令' + colors.reset);
            break;
            
        case '.where':
            if (bot && bot.entity) {
                const pos = bot.entity.position;
                safeLog(colors.green + `[${getTimestamp()}] 机器人位置: X=${pos.x.toFixed(2)}, Y=${pos.y.toFixed(2)}, Z=${pos.z.toFixed(2)}` + colors.reset);
            } else {
                safeLog(colors.red + `[${getTimestamp()}] 错误: Bot未连接到服务器` + colors.reset);
            }
            break;
            
        case '.time':
            if (bot) {
                const time = bot.time.timeOfDay;
                const hours = Math.floor(time / 1000) + 6; // MC时间从6AM开始
                const minutes = Math.floor((time % 1000) / 1000 * 60);
                const realHours = hours % 24;
                safeLog(colors.green + `[${getTimestamp()}] 服务器时间: ${time} ticks (约 ${realHours}:${minutes.toString().padStart(2, '0')})` + colors.reset);
            } else {
                safeLog(colors.red + `[${getTimestamp()}] 错误: Bot未连接到服务器` + colors.reset);
            }
            break;
            
        case '.info':
            if (bot && bot.entity) {
                const dimension = bot.game.dimension || '未知';
                const health = bot.health.toFixed(1);
                const food = bot.food.toFixed(1);
                const onlineTime = getOnlineTime();
                
                safeLog(colors.cyan + `[${getTimestamp()}] Bot状态信息:` + colors.reset);
                safeLog(`  世界维度: ${dimension}`);
                safeLog(`  生命值: ${health}/20.0`);
                safeLog(`  饱食度: ${food}/20.0`);
                safeLog(`  在线时间: ${onlineTime}`);
            } else {
                safeLog(colors.red + `[${getTimestamp()}] 错误: Bot未连接到服务器` + colors.reset);
            }
            break;
            
        case '.find':
            if (bot && bot.entity) {
                const players = [];
                const botPos = bot.entity.position;
                
                Object.values(bot.players).forEach(player => {
                    if (player.entity && player.username !== bot.username) {
                        const playerPos = player.entity.position;
                        const distance = botPos.distanceTo(playerPos);
                        players.push({
                            username: player.username,
                            distance: distance
                        });
                    }
                });
                
                players.sort((a, b) => a.distance - b.distance);
                
                if (players.length > 0) {
                    safeLog(colors.green + `[${getTimestamp()}] 可见玩家列表:` + colors.reset);
                    players.forEach(player => {
                        try {
                            if (player.entity && player.entity.position) {
                                const pos = player.entity.position;
                                safeLog(`  ${player.username} - 距离:${player.distance.toFixed(2)}方块, 坐标:(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`);
                            } else {
                                safeLog(`  ${player.username} - 距离:${player.distance.toFixed(2)}方块`);
                            }
                        } catch (error) {
                            logError(error);
                            safeLog(`  ${player.username} - 距离:${player.distance.toFixed(2)}方块`);
                        }
                    });
                } else {
                    safeLog(colors.yellow + `[${getTimestamp()}] 附近没有可见的玩家` + colors.reset);
                }
            } else {
                safeLog(colors.red + `[${getTimestamp()}] 错误: Bot未连接到服务器` + colors.reset);
            }
            break;
            
        case '.find_block':
            if (parts.length < 2) {
                safeLog(colors.red + `[${getTimestamp()}] 用法: .find_block <方块名>` + colors.reset);
                break;
            }
            
            if (bot && bot.entity) {
                const blockName = parts[1];
                const botPos = bot.entity.position;
                const range = 16; // 搜索范围
                let count = 0;
                let found = false;
                
                try {
                    for (let x = -range; x <= range; x++) {
                        for (let y = -range; y <= range; y++) {
                            for (let z = -range; z <= range; z++) {
                                const checkPos = botPos.offset(x, y, z);
                                const block = bot.blockAt(checkPos);
                                if (block && (block.name === blockName || block.name.includes(blockName))) {
                                    count++;
                                    found = true;
                                }
                            }
                        }
                    }
                    
                    if (found) {
                        safeLog(colors.green + `[${getTimestamp()}] 找到方块 "${blockName}": 存在, 数量: ${count}` + colors.reset);
                    } else {
                        safeLog(colors.yellow + `[${getTimestamp()}] 方块 "${blockName}": 不存在, 数量: 0` + colors.reset);
                    }
                } catch (error) {
                    safeLog(colors.red + `[${getTimestamp()}] 搜索方块时出错: ${error.message}` + colors.reset);
                }
            } else {
                safeLog(colors.red + `[${getTimestamp()}] 错误: Bot未连接到服务器` + colors.reset);
            }
            break;
            
        case '.go':
            if (parts[1] === 'stop') {
                stopAllMovement();
                safeLog(colors.yellow + `[${getTimestamp()}] 停止寻路任务` + colors.reset);
                break;
            }
            
            if (parts.length < 4) {
                safeLog(colors.red + `[${getTimestamp()}] 用法: .go <x> <y> <z> 或 .go stop` + colors.reset);
                break;
            }
            
            if (bot && bot.entity) {
                try {
                    const x = parseFloat(parts[1]);
                    const y = parseFloat(parts[2]);
                    const z = parseFloat(parts[3]);
                    
                    if (isNaN(x) || isNaN(y) || isNaN(z)) {
                        safeLog(colors.red + `[${getTimestamp()}] 错误: 坐标必须是数字` + colors.reset);
                        break;
                    }
                    
                    const currentPos = bot.entity.position;
                    const targetPos = { x: x, y: y, z: z };
                    const initialDistance = currentPos.distanceTo(targetPos);
                    bot.initialDistance = initialDistance;
                    
                    safeLog(colors.yellow + `[${getTimestamp()}] 开始寻路到坐标 (${x}, ${y}, ${z})，距离: ${initialDistance.toFixed(2)}方块` + colors.reset);
                    
                    // 使用pathfinder进行寻路
                    const mcData = require('minecraft-data')(bot.version);
                    const movements = new Movements(bot, mcData);
                    
                    // 设置移动参数
                    movements.scafoldingBlocks = []; // 不使用脚手架
                    movements.canDig = true; // 允许挖掘
                    movements.allow1by1towers = false; // 不允许1x1塔
                    
                    bot.pathfinder.setMovements(movements);
                    
                    // 设置目标
                    const goal = new GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));
                    bot.pathfinder.setGoal(goal);
                    
                    // 开始进度报告
                    startMovementProgress(targetPos);
                    
                } catch (error) {
                    safeLog(colors.red + `[${getTimestamp()}] 寻路时出错: ${error.message}` + colors.reset);
                }
            } else {
                safeLog(colors.red + `[${getTimestamp()}] 错误: Bot未连接到服务器` + colors.reset);
            }
            break;
            
        case '.open':
            if (parts.length < 3) {
                safeLog(colors.red + `[${getTimestamp()}] 用法: .open <方块名> <A/B>` + colors.reset);
                break;
            }
            
            if (bot && bot.entity) {
                const blockName = parts[1];
                const action = parts[2].toUpperCase();
                
                if (action !== 'A' && action !== 'B') {
                    safeLog(colors.red + `[${getTimestamp()}] 错误: 动作必须是 A 或 B` + colors.reset);
                    break;
                }
                
                try {
                    // 寻找最近的指定方块
                    const botPos = bot.entity.position;
                    let nearestBlock = null;
                    let nearestDistance = Infinity;
                    
                    for (let x = -16; x <= 16; x++) {
                        for (let y = -16; y <= 16; y++) {
                            for (let z = -16; z <= 16; z++) {
                                const checkPos = botPos.offset(x, y, z);
                                const block = bot.blockAt(checkPos);
                                if (block && (block.name === blockName || block.name.includes(blockName))) {
                                    const distance = botPos.distanceTo(checkPos);
                                    if (distance < nearestDistance) {
                                        nearestDistance = distance;
                                        nearestBlock = block;
                                    }
                                }
                            }
                        }
                    }
                    
                    if (!nearestBlock) {
                        safeLog(colors.red + `[${getTimestamp()}] 未找到方块: ${blockName}` + colors.reset);
                        break;
                    }
                    
                    safeLog(colors.yellow + `[${getTimestamp()}] 找到方块 ${blockName}，距离: ${nearestDistance.toFixed(2)}方块，正在前往...` + colors.reset);
                    
                    // 寻路到方块附近
                    const mcData = require('minecraft-data')(bot.version);
                    const movements = new Movements(bot, mcData);
                    bot.pathfinder.setMovements(movements);
                    
                    const goal = new GoalNear(nearestBlock.position.x, nearestBlock.position.y, nearestBlock.position.z, 2);
                    bot.pathfinder.setGoal(goal);
                    
                    // 监听寻路完成
                    bot.once('goal_reached', async () => {
                        try {
                            // 等待一小段时间确保到位
                            await new Promise(resolve => setTimeout(resolve, 500));
                            
                            // 面向方块
                            await bot.lookAt(nearestBlock.position.offset(0.5, 0.5, 0.5));
                            
                            // 检查距离
                            const currentDistance = bot.entity.position.distanceTo(nearestBlock.position);
                            if (currentDistance > 3) {
                                safeLog(colors.red + `[${getTimestamp()}] 距离太远 (${currentDistance.toFixed(2)}方块)，无法操作` + colors.reset);
                                return;
                            }
                            
                            safeLog(colors.green + `[${getTimestamp()}] 已到达方块附近，执行${action === 'A' ? '破坏' : '打开'}操作...` + colors.reset);
                            
                            if (action === 'A') {
                                // 破坏方块
                                await bot.dig(nearestBlock);
                                safeLog(colors.green + `[${getTimestamp()}] 方块已破坏` + colors.reset);
                            } else {
                                // 打开/激活方块
                                await bot.activateBlock(nearestBlock);
                                safeLog(colors.green + `[${getTimestamp()}] 方块已激活` + colors.reset);
                            }
                            
                        } catch (error) {
                            safeLog(colors.red + `[${getTimestamp()}] 操作方块时出错: ${error.message}` + colors.reset);
                        }
                    });
                    
                } catch (error) {
                    safeLog(colors.red + `[${getTimestamp()}] 寻找方块时出错: ${error.message}` + colors.reset);
                }
            } else {
                safeLog(colors.red + `[${getTimestamp()}] 错误: Bot未连接到服务器` + colors.reset);
            }
            break;
            
        case '.chest':
            if (bot && gui && gui.window) {
                safeLog(colors.cyan + `[${getTimestamp()}] 当前打开的容器内容:` + colors.reset);
                const window = gui.window;
                safeLog(`  容器类型: ${window.type}`);
                safeLog(`  容器标题: ${window.title || '无标题'}`);
                safeLog(`  槽位数量: ${window.slots.length}`);
                
                for (let i = 0; i < window.slots.length; i++) {
                    const item = window.slots[i];
                    if (item) {
                        safeLog(`  槽位 ${i}: ${item.name} x${item.count}`);
                    }
                }
            } else {
                safeLog(colors.yellow + `[${getTimestamp()}] 当前没有打开任何容器` + colors.reset);
            }
            break;
            
        case '.inv':
            if (bot && bot.inventory) {
                safeLog(colors.cyan + `[${getTimestamp()}] 完整背包内容:` + colors.reset);
                
                // 显示快捷栏
                safeLog(colors.yellow + '快捷栏 (0-8):' + colors.reset);
                for (let i = 0; i < 9; i++) {
                    const item = bot.inventory.slots[36 + i];
                    const current = bot.quickBarSlot === i ? ' [当前]' : '';
                    if (item) {
                        safeLog(`  ${i}: ${item.name} x${item.count}${current}`);
                    }
                }
                
                // 显示主背包
                safeLog(colors.yellow + '主背包 (9-35):' + colors.reset);
                for (let i = 9; i < 36; i++) {
                    const item = bot.inventory.slots[i];
                    if (item) {
                        safeLog(`  槽位 ${i}: ${item.name} x${item.count}`);
                    }
                }
                
                // 显示装备槽
                safeLog(colors.yellow + '装备槽:' + colors.reset);
                const armorSlots = ['头盔', '胸甲', '护腿', '靴子'];
                for (let i = 0; i < 4; i++) {
                    const item = bot.inventory.slots[8 - i];
                    if (item) {
                        safeLog(`  ${armorSlots[i]}: ${item.name}`);
                    }
                }
            } else {
                safeLog(colors.red + `[${getTimestamp()}] 错误: Bot未连接到服务器` + colors.reset);
            }
            break;
            
        case '.exit':
            safeLog(colors.yellow + `[${getTimestamp()}] 正在退出程序...` + colors.reset);
            if (reconnectInterval) {
                clearInterval(reconnectInterval);
            }
            if (bot) {
                bot.quit();
            }
            process.exit(0);
            break;

        case '.hunt':
            if (!bot || !bot.entity) {
                safeLog(colors.red + `[${getTimestamp()}] 错误: Bot未连接到服务器` + colors.reset);
                break;
            }

            if (parts.length < 2 || parts[1] === 'stop') {
                stopAllMovement();
                safeLog(colors.yellow + `[${getTimestamp()}] 停止跟随玩家` + colors.reset);
                break;
            }

            const targetPlayer = parts[1];
            const player = bot.players[targetPlayer];

            if (!player || !player.entity) {
                safeLog(colors.red + `[${getTimestamp()}] 错误: 找不到玩家 ${targetPlayer}` + colors.reset);
                break;
            }

            followingPlayer = targetPlayer;
            safeLog(colors.green + `[${getTimestamp()}] 开始跟随玩家: ${targetPlayer}` + colors.reset);

            if (followingInterval) {
                clearInterval(followingInterval);
            }

            followingInterval = setInterval(() => {
                try {
                    if (!bot || !bot.entity || !followingPlayer) {
                        clearInterval(followingInterval);
                        followingInterval = null;
                        return;
                    }

                    const player = bot.players[followingPlayer];
                    if (!player || !player.entity) {
                        safeLog(colors.yellow + `[${getTimestamp()}] 无法找到玩家 ${followingPlayer}，停止跟随` + colors.reset);
                        stopAllMovement();
                        return;
                    }

                    const mcData = require('minecraft-data')(bot.version);
                    const movements = new Movements(bot, mcData);
                    bot.pathfinder.setMovements(movements);
                    const goal = new goals.GoalNear(player.entity.position.x, player.entity.position.y, player.entity.position.z, 2);
                    bot.pathfinder.setGoal(goal);
                } catch (error) {
                    logError(error);
                    safeLog(colors.red + `[${getTimestamp()}] 跟随玩家时出错` + colors.reset);
                }
            }, 1000);
            break;

        case '.hand':
            if (parts.length < 2) {
                safeLog(colors.red + `[${getTimestamp()}] 用法: .hand info|<0-9>|use <A/B>` + colors.reset);
                break;
            }
            
            if (bot && bot.entity) {
                const subCmd = parts[1];
                
                if (subCmd === 'info') {
                    safeLog(colors.cyan + `[${getTimestamp()}] 物品栏信息:` + colors.reset);
                    
                    // 显示快捷栏
                    safeLog(colors.yellow + '快捷栏 (0-8):' + colors.reset);
                    for (let i = 0; i < 9; i++) {
                        const item = bot.inventory.slots[36 + i]; // 快捷栏从槽位36开始
                        const current = bot.quickBarSlot === i ? ' [当前]' : '';
                        if (item) {
                            safeLog(`  ${i}: ${item.name} x${item.count}${current}`);
                        } else {
                            safeLog(`  ${i}: 空${current}`);
                        }
                    }
                    
                    // 显示手持物品
                    const heldItem = bot.heldItem;
                    if (heldItem) {
                        safeLog(colors.green + `当前手持: ${heldItem.name} x${heldItem.count}` + colors.reset);
                    } else {
                        safeLog(colors.green + '当前手持: 空' + colors.reset);
                    }
                    
                } else if (subCmd >= '0' && subCmd <= '9') {
                    const slot = parseInt(subCmd);
                    try {
                        bot.setQuickBarSlot(slot);
                        const item = bot.inventory.slots[36 + slot];
                        const itemName = item ? `${item.name} x${item.count}` : '空';
                        safeLog(colors.green + `[${getTimestamp()}] 切换到槽位 ${slot}: ${itemName}` + colors.reset);
                    } catch (error) {
                        safeLog(colors.red + `[${getTimestamp()}] 切换槽位失败: ${error.message}` + colors.reset);
                    }
                    
                } else if (subCmd === 'use') {
                    if (parts.length < 3) {
                        safeLog(colors.red + `[${getTimestamp()}] 用法: .hand use <A/B>` + colors.reset);
                        break;
                    }
                    
                    const action = parts[2].toUpperCase();
                    try {
                        if (action === 'A') {
                            bot.swingArm('right');
                            safeLog(colors.green + `[${getTimestamp()}] 执行左键动作` + colors.reset);
                        } else if (action === 'B') {
                            bot.activateItem(false); // 右键使用物品
                            safeLog(colors.green + `[${getTimestamp()}] 执行右键动作` + colors.reset);
                        } else {
                            safeLog(colors.red + `[${getTimestamp()}] 错误: 动作必须是 A 或 B` + colors.reset);
                        }
                    } catch (error) {
                        safeLog(colors.red + `[${getTimestamp()}] 执行动作失败: ${error.message}` + colors.reset);
                    }
                    
                } else {
                    safeLog(colors.red + `[${getTimestamp()}] 未知的hand子命令: ${subCmd}` + colors.reset);
                }
            } else {
                safeLog(colors.red + `[${getTimestamp()}] 错误: Bot未连接到服务器` + colors.reset);
            }
            break;
            
        default:
            safeLog(colors.red + `[${getTimestamp()}] 未知命令: ${cmd}，输入 .help 查看帮助` + colors.reset);
            break;
    }
}

// 创建bot
function createBot() {
    safeLog(colors.yellow + `[${getTimestamp()}] 正在连接到服务器...` + colors.reset);
    
    bot = mineflayer.createBot({
        host: config.server_address,
        port: 25565,
        username: config.username,
        version: config.server_version,
        auth: 'offline'
    });

    // 加载pathfinder插件
    bot.loadPlugin(pathfinder);

    // 尝试加载GUI插件
    try {
        const GuiPlugin = require('mineflayer-gui');
        bot.loadPlugin(GuiPlugin);
        gui = bot.gui;
    } catch (error) {
        safeLog(colors.yellow + `[${getTimestamp()}] GUI插件未安装，容器功能将受限` + colors.reset);
    }

    // 连接成功
    bot.on('login', () => {
        safeLog(colors.green + `[${getTimestamp()}] 成功连接到服务器!` + colors.reset);
        startTime = Date.now(); // 记录登录时间
        
        // 等待一秒后执行初始命令
        setTimeout(() => {
            if (config.init_command) {
                safeLog(colors.blue + `[${getTimestamp()}] 执行初始命令: ${config.init_command}` + colors.reset);
                bot.chat(config.init_command);
            }
        }, 1000);
        
        // 等待3秒后开始监听
        setTimeout(() => {
            safeLog(colors.blue + `[${getTimestamp()}] 开始监听服务器消息...` + colors.reset);
            safeLog(colors.cyan + '提示: 输入.help查看内置命令，直接输入文本发送聊天消息' + colors.reset);
            setupEventListeners();
        }, 3000);
    });

    // 寻路相关事件
    bot.on('goal_reached', () => {
        if (isMoving) {
            safeLog(colors.green + `[${getTimestamp()}] 已到达目标位置!` + colors.reset);
            stopMovementProgress();
        }
    });

    bot.on('path_update', (r) => {
        // 可以在这里添加路径更新的处理
    });

    bot.on('goal_updated', (goal) => {
        // 目标更新时的处理
    });

    // 死亡事件
    bot.on('death', () => {
        safeLog(colors.red + `[${getTimestamp()}] 机器人死亡！正在尝试复活...` + colors.reset);
        
        setTimeout(() => {
            try {
                bot.chat('/respawn'); // 尝试复活命令
                safeLog(colors.yellow + `[${getTimestamp()}] 已发送复活命令` + colors.reset);
            } catch (error) {
                safeLog(colors.red + `[${getTimestamp()}] 复活失败: ${error.message}` + colors.reset);
            }
        }, 1000);
    });

    // 健康状态变化
    bot.on('health', () => {
        if (bot.health <= 0) {
            safeLog(colors.red + `[${getTimestamp()}] 生命值归零，死因可能是战斗、掉落或其他伤害` + colors.reset);
        } else if (bot.health < 5) {
            safeLog(colors.yellow + `[${getTimestamp()}] 警告：生命值过低 (${bot.health}/20)` + colors.reset);
        }
    });

    // 容器打开事件
    bot.on('windowOpen', (window) => {
        safeLog(colors.cyan + `[${getTimestamp()}] 打开容器: ${window.type} - ${window.title || '无标题'}` + colors.reset);
    });

    // 容器关闭事件
    bot.on('windowClose', (window) => {
        try {
            if (window && window.type) {
                safeLog(colors.yellow + `[${getTimestamp()}] 关闭容器: ${window.type}` + colors.reset);
            } else {
                safeLog(colors.yellow + `[${getTimestamp()}] 关闭容器` + colors.reset);
            }
        } catch (error) {
            logError(error);
            safeLog(colors.red + `[${getTimestamp()}] 容器关闭事件处理出错` + colors.reset);
        }
    });

    // 连接错误
    bot.on('error', (err) => {
        safeLog(colors.red + `[${getTimestamp()}] Bot错误: ${err.message}` + colors.reset);
    });

    // 断开连接
    bot.on('end', (reason) => {
        safeLog(colors.red + `[${getTimestamp()}] 与服务器断开连接: ${reason || '未知原因'}` + colors.reset);
        stopMovementProgress();
        scheduleReconnect();
    });

    // 被踢出服务器
    bot.on('kicked', (reason) => {
        safeLog(colors.red + `[${getTimestamp()}] 被服务器踢出: ${removeColorCodes(reason)}` + colors.reset);
        stopMovementProgress();
        scheduleReconnect();
    });
}

// 设置事件监听器
function setupEventListeners() {
    // 监听聊天消息
    bot.on('messagestr', (message, messagePosition) => {
        // 过滤掉一些系统消息和重复消息
        if (messagePosition === 'game_info') return;
        
        const cleanMessage = removeColorCodes(message);
        
        // 解析消息类型并着色
        let coloredMessage = cleanMessage;
        
        // 聊天消息格式检测
        if (cleanMessage.match(/^<\w+>/)) {
            coloredMessage = colors.white + cleanMessage + colors.reset;
        }
        // 系统消息
        else if (cleanMessage.includes('joined the game') || cleanMessage.includes('加入了游戏')) {
            coloredMessage = colors.green + cleanMessage + colors.reset;
            // 提取玩家名并加入已知玩家列表
            const match = cleanMessage.match(/(\w+).*(?:joined the game|加入了游戏)/);
            if (match) {
                knownPlayers.add(match[1]);
            }
        }
        else if (cleanMessage.includes('left the game') || cleanMessage.includes('离开了游戏')) {
            coloredMessage = colors.red + cleanMessage + colors.reset;
        }
        // 死亡消息检测
        else if (cleanMessage.includes(bot.username) && 
                (cleanMessage.includes('was slain') || cleanMessage.includes('fell') || 
                 cleanMessage.includes('drowned') || cleanMessage.includes('burned') ||
                 cleanMessage.includes('died') || cleanMessage.includes('killed'))) {
            coloredMessage = colors.red + colors.bold + `[死亡] ${cleanMessage}` + colors.reset;
            safeLog(colors.red + `[${getTimestamp()}] 死因: ${cleanMessage}` + colors.reset);
        }
        // 私聊消息
        else if (cleanMessage.match(/^\w+ whispers to you:/) || cleanMessage.match(/^你收到来自 \w+ 的私聊/)) {
            coloredMessage = colors.magenta + cleanMessage + colors.reset;
        }
        // 服务器消息
        else if (cleanMessage.startsWith('[Server]') || cleanMessage.startsWith('服务器')) {
            coloredMessage = colors.cyan + cleanMessage + colors.reset;
        }
        
        safeLog(`[${getTimestamp()}] ${coloredMessage}`);
    });

    // 监听玩家加入
    bot.on('playerJoined', (player) => {
        const username = player.username;
        knownPlayers.add(username);
        safeLog(colors.green + `[${getTimestamp()}] 玩家加入: ${username}` + colors.reset);
    });

    // 监听玩家离开
    bot.on('playerLeft', (player) => {
        const username = player.username;
        safeLog(colors.red + `[${getTimestamp()}] 玩家离开: ${username}` + colors.reset);
    });

    // 更新已知玩家列表
    bot.on('playerUpdated', (player) => {
        if (player.username) {
            knownPlayers.add(player.username);
        }
    });
}

// 安排重连
function scheduleReconnect() {
    if (reconnectInterval) {
        clearInterval(reconnectInterval);
    }
    
    safeLog(colors.yellow + `[${getTimestamp()}] 将在5秒后尝试重连...` + colors.reset);
    
    reconnectInterval = setInterval(() => {
        safeLog(colors.yellow + `[${getTimestamp()}] 正在尝试重连...` + colors.reset);
        try {
            createBot();
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        } catch (error) {
            safeLog(colors.red + `[${getTimestamp()}] 重连失败: ${error.message}` + colors.reset);
        }
    }, 5000);
}

// 主函数
function main() {
    console.log(colors.blue + colors.bold + '=== Minecraft交互式Bot (增强版) ===' + colors.reset);
    console.log('');
    
    if (!readConfig()) {
        console.error(colors.red + '无法读取配置文件，程序退出' + colors.reset);
        process.exit(1);
    }
    
    // 验证必要的配置
    const requiredFields = ['server_address', 'server_version', 'username'];
    const missingFields = requiredFields.filter(field => !config[field]);
    
    if (missingFields.length > 0) {
        console.error(colors.red + `缺少必要配置: ${missingFields.join(', ')}` + colors.reset);
        process.exit(1);
    }
    
    // 创建交互式终端
    createInteractiveTerminal();
    
    // 连接到服务器
    createBot();
}

// 启动程序
main();
