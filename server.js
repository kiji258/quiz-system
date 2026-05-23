const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// 托管静态文件（index.html 等）
app.use(express.static(__dirname));

// ==================== 预设队伍（最多13队） ====================
const PRESET_TEAMS = [
    { id: 0, name: '拌料队', emoji: '🥣', color: '#ef4444' },
    { id: 1, name: '焙烧队', emoji: '🔥', color: '#f59e0b' },
    { id: 2, name: '浸出队', emoji: '💧', color: '#3b82f6' },
    { id: 3, name: '净化队', emoji: '✨', color: '#10b981' },
    { id: 4, name: 'MVR队', emoji: '🌀', color: '#8b5cf6' },
    { id: 5, name: '合成队', emoji: '⚗️', color: '#ec4899' },
    { id: 6, name: '人事行政+污水站', emoji: '🧑‍💼', color: '#14b8a6' },
    { id: 7, name: '资材+品质', emoji: '📦', color: '#f97316' },
    { id: 8, name: '研创中心+化验室', emoji: '🔬', color: '#6366f1' },
    { id: 9, name: '观众队', emoji: '👥', color: '#a855f7' },
    // 如需更多队伍，可继续添加至 id:12，最多13队
];

// ==================== 题库 ====================
const QUESTIONS = [
    { id: 1, type: '选择题', question: '中国的首都是哪个城市？', options: ['上海', '北京', '广州', '深圳'], answer: 1 },
    { id: 2, type: '选择题', question: '地球上最大的海洋是？', options: ['大西洋', '印度洋', '太平洋', '北冰洋'], answer: 2 },
    { id: 3, type: '判断题', question: '光在真空中的速度约为每秒30万公里。', options: ['正确', '错误'], answer: 0 },
    { id: 4, type: '选择题', question: '以下哪个不是编程语言？', options: ['Python', 'Java', 'Photoshop', 'C++'], answer: 2 },
    { id: 5, type: '选择题', question: '人体最大的器官是？', options: ['心脏', '肝脏', '皮肤', '大脑'], answer: 2 },
    { id: 6, type: '判断题', question: '月球自身会发光。', options: ['正确', '错误'], answer: 1 },
    { id: 7, type: '选择题', question: '"会当凌绝顶，一览众山小"描写的是哪座山？', options: ['黄山', '泰山', '华山', '庐山'], answer: 1 },
    { id: 8, type: '选择题', question: '水的化学式是？', options: ['CO₂', 'H₂O', 'NaCl', 'O₂'], answer: 1 },
    { id: 9, type: '判断题', question: '鲸鱼是鱼类。', options: ['正确', '错误'], answer: 1 },
    { id: 10, type: '选择题', question: '世界杯足球赛每几年举办一次？', options: ['2年', '3年', '4年', '5年'], answer: 2 }
];

// ==================== 全局状态 ====================
let gameState = {
    players: PRESET_TEAMS.map(t => ({ ...t, score: 0 })),
    questions: QUESTIONS,
    currentQIndex: 0,
    questionStatus: {},       // { questionId: 'done' | 'skipped' }
    roundState: 'IDLE',       // IDLE, SHOWING, READY_TO_BUZZ, BUZZED, ANSWERING, JUDGED, TIMEOUT
    buzzerPlayerId: null,
    buzzRemain: 5,
    answerRemain: 10,
    correctPoints: 10,
    wrongPoints: 5,
    buzzTimeoutSec: 5,
    answerTimeoutSec: 10,
};

// ==================== WebSocket 广播 ====================
function broadcastState() {
    const data = JSON.stringify({ type: 'STATE', state: gameState });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    });
}

// ==================== WebSocket 连接处理 ====================
wss.on('connection', (ws) => {
    console.log('新客户端连接');
    ws.send(JSON.stringify({ type: 'STATE', state: gameState }));

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'HOST_ACTION') {
                // 主持人更新状态
                Object.assign(gameState, data.state);
                broadcastState();
            } else if (data.type === 'PLAYER_BUZZ') {
                // 选手抢答
                if (gameState.roundState === 'READY_TO_BUZZ') {
                    gameState.roundState = 'BUZZED';
                    gameState.buzzerPlayerId = data.playerId;
                    broadcastState();
                }
            }
        } catch (err) {
            console.error('消息处理错误:', err);
        }
    });

    ws.on('close', () => console.log('客户端断开'));
});

// ==================== 启动服务器 ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});