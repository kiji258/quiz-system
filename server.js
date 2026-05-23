const express = require('express');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));

// ---------- 预设队伍（最多13队）----------
const PRESET_TEAMS = [
    { id: 0, name: '拌料队', emoji: '🥣', color: '#ef4444', score: 0 },
    { id: 1, name: '焙烧队', emoji: '🔥', color: '#f59e0b', score: 0 },
    { id: 2, name: '浸出队', emoji: '💧', color: '#3b82f6', score: 0 },
    { id: 3, name: '净化队', emoji: '✨', color: '#10b981', score: 0 },
    { id: 4, name: 'MVR队', emoji: '🌀', color: '#8b5cf6', score: 0 },
    { id: 5, name: '合成队', emoji: '⚗️', color: '#ec4899', score: 0 },
    { id: 6, name: '人事行政+污水站', emoji: '🧑‍💼', color: '#14b8a6', score: 0 },
    { id: 7, name: '资材+品质', emoji: '📦', color: '#f97316', score: 0 },
    { id: 8, name: '研创中心+化验室', emoji: '🔬', color: '#6366f1', score: 0 },
    { id: 9, name: '观众队', emoji: '👥', color: '#a855f7', score: 0 },
];

// 题库（用于抢答和互问互答共用）
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

// 全局状态
let gameState = {
    players: PRESET_TEAMS.map(t => ({ ...t })),
    currentActivity: 'rush', // 'rush' 或 'mutual'
    // 抢答活动状态
    rush: {
        roundState: 'IDLE', // IDLE, SHOWING, RUSHING, ANSWERING, FINISHED
        currentQuestion: null,
        questionStartTime: 0,
        rushEndTime: 0,
        answerEndTime: 0,
        buzzerPlayerId: null,
        correctAnswer: null,
    },
    // 互问互答状态
    mutual: {
        currentDrawTeamId: 0,      // 当前轮到抽题的队伍id
        currentAnswerTeamId: 1,    // 当前需要回答的队伍id（抽题者的下一个）
        currentQuestion: null,
        answerEndTime: 0,
        answeringPlayerId: null,    // 正在答题的选手的队伍id（与answerTeamId一致）
        roundActive: false,         // 是否在一轮问答中（抽题后到答题结束）
    },
    // 通用
    correctPoints: 10,
};

// 辅助函数：广播状态
function broadcastState() {
    const data = JSON.stringify({ type: 'STATE', state: gameState });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    });
}

// 处理抢答判分
function handleRushAnswer(playerId, selectedIndex) {
    const rush = gameState.rush;
    if (rush.roundState !== 'ANSWERING') return false;
    if (rush.buzzerPlayerId !== playerId) return false;
    const isCorrect = (selectedIndex === rush.correctAnswer);
    const player = gameState.players.find(p => p.id === playerId);
    if (isCorrect) {
        player.score += gameState.correctPoints;
        broadcastState();
        // 通知结果
        return { correct: true, msg: `恭喜 ${player.name} 回答正确！ +${gameState.correctPoints}分` };
    } else {
        // 错误不加分不扣分
        broadcastState();
        return { correct: false, msg: `再接再厉！ ${player.name} 回答错误。` };
    }
}

// 处理互问互答答题
function handleMutualAnswer(playerId, selectedIndex) {
    const mutual = gameState.mutual;
    if (!mutual.roundActive) return false;
    if (mutual.answeringPlayerId !== playerId) return false;
    if (Date.now() > mutual.answerEndTime) return false;
    const isCorrect = (selectedIndex === mutual.currentQuestion.answer);
    const player = gameState.players.find(p => p.id === playerId);
    if (isCorrect) {
        player.score += gameState.correctPoints;
    }
    // 结束本轮
    mutual.roundActive = false;
    mutual.currentQuestion = null;
    mutual.answeringPlayerId = null;
    // 抽题队伍前进到下一个
    mutual.currentDrawTeamId = (mutual.currentDrawTeamId + 1) % gameState.players.length;
    mutual.currentAnswerTeamId = (mutual.currentDrawTeamId + 1) % gameState.players.length;
    broadcastState();
    return { correct: isCorrect, msg: isCorrect ? `回答正确！ +${gameState.correctPoints}分` : `回答错误！ 正确答案是 ${mutual.currentQuestion.options[mutual.currentQuestion.answer]}` };
}

// WebSocket 连接处理
wss.on('connection', (ws) => {
    console.log('新客户端连接');
    ws.send(JSON.stringify({ type: 'STATE', state: gameState }));

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'HOST_ACTION') {
                // 主持人操作
                const { action, payload } = data;
                if (action === 'selectActivity') {
                    gameState.currentActivity = payload;
                    // 重置活动状态
                    if (payload === 'rush') {
                        gameState.rush = { roundState: 'IDLE', currentQuestion: null, questionStartTime: 0, rushEndTime: 0, answerEndTime: 0, buzzerPlayerId: null, correctAnswer: null };
                    } else {
                        gameState.mutual = { currentDrawTeamId: 0, currentAnswerTeamId: 1, currentQuestion: null, answerEndTime: 0, answeringPlayerId: null, roundActive: false };
                    }
                    broadcastState();
                } else if (action === 'startRush') {
                    // 开始抢答：随机选一题，40秒抢答倒计时
                    if (gameState.currentActivity !== 'rush') return;
                    const randomIndex = Math.floor(Math.random() * QUESTIONS.length);
                    const question = { ...QUESTIONS[randomIndex] };
                    gameState.rush.currentQuestion = question;
                    gameState.rush.correctAnswer = question.answer;
                    gameState.rush.roundState = 'RUSHING';
                    gameState.rush.questionStartTime = Date.now();
                    gameState.rush.rushEndTime = Date.now() + 40000; // 40秒抢答窗口
                    gameState.rush.buzzerPlayerId = null;
                    broadcastState();
                } else if (action === 'drawQuestion') {
                    // 互问互答：抽题（由当前抽题队伍触发）
                    if (gameState.currentActivity !== 'mutual') return;
                    if (gameState.mutual.roundActive) return;
                    const drawTeamId = payload.drawTeamId;
                    if (drawTeamId !== gameState.mutual.currentDrawTeamId) return;
                    const randomIndex = Math.floor(Math.random() * QUESTIONS.length);
                    const question = { ...QUESTIONS[randomIndex] };
                    gameState.mutual.currentQuestion = question;
                    gameState.mutual.roundActive = true;
                    gameState.mutual.answeringPlayerId = gameState.mutual.currentAnswerTeamId;
                    gameState.mutual.answerEndTime = Date.now() + 80000; // 80秒答题时间
                    broadcastState();
                }
            } else if (data.type === 'PLAYER_RUSH') {
                // 选手抢答
                const rush = gameState.rush;
                if (gameState.currentActivity !== 'rush') return;
                if (rush.roundState !== 'RUSHING') return;
                if (rush.buzzerPlayerId !== null) return; // 已经有人抢到
                if (Date.now() > rush.rushEndTime) return;
                rush.buzzerPlayerId = data.playerId;
                rush.roundState = 'ANSWERING';
                rush.answerEndTime = Date.now() + 6000; // 6秒答题
                broadcastState();
            } else if (data.type === 'PLAYER_ANSWER') {
                // 选手提交答案
                if (gameState.currentActivity === 'rush') {
                    const result = handleRushAnswer(data.playerId, data.answerIndex);
                    if (result) {
                        ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result }));
                        // 抢答结束，重置状态
                        gameState.rush.roundState = 'FINISHED';
                        broadcastState();
                        // 3秒后自动回到IDLE
                        setTimeout(() => {
                            if (gameState.rush.roundState === 'FINISHED') {
                                gameState.rush.roundState = 'IDLE';
                                broadcastState();
                            }
                        }, 3000);
                    }
                } else if (gameState.currentActivity === 'mutual') {
                    const result = handleMutualAnswer(data.playerId, data.answerIndex);
                    if (result) {
                        ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result }));
                    }
                }
            }
        } catch (err) {
            console.error('处理消息错误', err);
        }
    });

    ws.on('close', () => console.log('客户端断开'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
