const express = require('express');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));
app.use(express.json()); // 解析 JSON 请求体

// ---------- 预设队伍 ----------
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

// ---------- 题库（初始示例）----------
let RUSH_QUESTIONS = [
    { id: 'r1', type: '选择题', question: '中国的首都是哪个城市？', options: ['上海', '北京', '广州', '深圳'], answer: 1 },
    { id: 'r2', type: '选择题', question: '地球上最大的海洋是？', options: ['大西洋', '印度洋', '太平洋', '北冰洋'], answer: 2 },
];
let MUTUAL_QUESTIONS = [
    { id: 'm1', type: '选择题', question: '灭火器压力表指针在什么区域表示正常？', options: ['红色', '绿色', '黄色', '蓝色'], answer: 1 },
];

// ---------- 问答历史记录 ----------
let answerHistory = []; // 每条记录: { id, timestamp, activityType, teamId, teamName, question, selectedAnswer, isCorrect, scoreChanged }

function addHistoryRecord(activityType, teamId, teamName, question, selectedAnswer, isCorrect, scoreDelta) {
    answerHistory.unshift({
        id: Date.now() + Math.random(),
        timestamp: new Date().toISOString(),
        activityType,
        teamId,
        teamName,
        question: question.question,
        selectedAnswer: selectedAnswer,
        isCorrect,
        scoreDelta,
    });
    // 保留最多200条
    if (answerHistory.length > 200) answerHistory.pop();
}

// ---------- 全局游戏状态 ----------
let gameState = {
    players: PRESET_TEAMS.map(t => ({ ...t })),
    currentActivity: 'rush',
    rush: {
        roundState: 'IDLE',
        currentQuestion: null,
        rushEndTime: 0,
        answerEndTime: 0,
        buzzerPlayerId: null,
        correctAnswer: null,
    },
    mutual: {
        currentDrawTeamId: 0,
        currentAnswerTeamId: 1,
        currentQuestion: null,
        answerEndTime: 0,
        answeringPlayerId: null,
        roundActive: false,
        teamAnswerCount: new Array(PRESET_TEAMS.length).fill(0),
        phaseEnded: false,
    },
    correctPoints: 10,
    lastBuzzWinner: null,      // { teamId, teamName, timestamp }
    lastAnswerResult: null,    // { teamId, teamName, isCorrect, message }
};

function broadcastState() {
    const data = JSON.stringify({ type: 'STATE', state: gameState });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    });
}

// 广播事件（单独发送给主持人或全部）
function broadcastEvent(eventType, payload) {
    const msg = JSON.stringify({ type: 'EVENT', eventType, payload });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}

// 处理抢答答题
function handleRushAnswer(playerId, selectedIndex) {
    const rush = gameState.rush;
    if (rush.roundState !== 'ANSWERING') return false;
    if (rush.buzzerPlayerId !== playerId) return false;
    const isCorrect = (selectedIndex === rush.correctAnswer);
    const player = gameState.players.find(p => p.id === playerId);
    let scoreDelta = 0;
    if (isCorrect) {
        scoreDelta = gameState.correctPoints;
        player.score += scoreDelta;
    }
    // 记录历史
    addHistoryRecord('rush', playerId, player.name, rush.currentQuestion, rush.currentQuestion.options[selectedIndex], isCorrect, scoreDelta);
    rush.roundState = 'FINISHED';
    // 记录抢答结果供主持人显示
    gameState.lastAnswerResult = {
        teamId: playerId,
        teamName: player.name,
        isCorrect,
        message: isCorrect ? `✅ ${player.name} 回答正确！ +${scoreDelta}分` : `❌ ${player.name} 回答错误！正确答案是 ${rush.currentQuestion.options[rush.correctAnswer]}`,
    };
    broadcastState();
    // 3秒后清除结果提示
    setTimeout(() => {
        if (gameState.lastAnswerResult && gameState.lastAnswerResult.teamId === playerId) {
            gameState.lastAnswerResult = null;
            broadcastState();
        }
        if (gameState.currentActivity === 'rush' && gameState.rush.roundState === 'FINISHED') {
            gameState.rush.roundState = 'IDLE';
            broadcastState();
        }
    }, 4000);
    return { correct: isCorrect, msg: gameState.lastAnswerResult.message };
}

// 处理互问互答答题
function handleMutualAnswer(playerId, selectedIndex) {
    const mutual = gameState.mutual;
    if (!mutual.roundActive) return false;
    if (mutual.answeringPlayerId !== playerId) return false;
    if (Date.now() > mutual.answerEndTime) return false;
    const isCorrect = (selectedIndex === mutual.currentQuestion.answer);
    const player = gameState.players.find(p => p.id === playerId);
    let scoreDelta = 0;
    if (isCorrect) {
        scoreDelta = gameState.correctPoints;
        player.score += scoreDelta;
    }
    // 记录历史
    addHistoryRecord('mutual', playerId, player.name, mutual.currentQuestion, mutual.currentQuestion.options[selectedIndex], isCorrect, scoreDelta);
    mutual.teamAnswerCount[playerId] = (mutual.teamAnswerCount[playerId] || 0) + 1;
    mutual.roundActive = false;
    mutual.currentQuestion = null;
    mutual.answeringPlayerId = null;
    // 记录结果
    gameState.lastAnswerResult = {
        teamId: playerId,
        teamName: player.name,
        isCorrect,
        message: isCorrect ? `✅ ${player.name} 回答正确！ +${scoreDelta}分` : `❌ ${player.name} 回答错误！正确答案是 ${mutual.currentQuestion.options[mutual.currentQuestion.answer]}`,
    };
    // 更新下一轮队伍
    let nextAnswerId = (playerId + 1) % gameState.players.length;
    while (mutual.teamAnswerCount[nextAnswerId] >= 2 && nextAnswerId !== playerId) {
        nextAnswerId = (nextAnswerId + 1) % gameState.players.length;
    }
    mutual.currentDrawTeamId = playerId;
    mutual.currentAnswerTeamId = nextAnswerId;
    broadcastState();
    setTimeout(() => {
        if (gameState.lastAnswerResult && gameState.lastAnswerResult.teamId === playerId) {
            gameState.lastAnswerResult = null;
            broadcastState();
        }
    }, 4000);
    return { correct: isCorrect, msg: gameState.lastAnswerResult.message };
}

// ---------- HTTP API 供管理员题库管理 ----------
app.get('/api/rush-questions', (req, res) => res.json(RUSH_QUESTIONS));
app.get('/api/mutual-questions', (req, res) => res.json(MUTUAL_QUESTIONS));
app.get('/api/history', (req, res) => res.json(answerHistory));

app.post('/api/rush-questions', (req, res) => {
    const q = req.body;
    q.id = 'r' + Date.now();
    RUSH_QUESTIONS.push(q);
    res.json({ success: true, id: q.id });
});
app.put('/api/rush-questions/:id', (req, res) => {
    const id = req.params.id;
    const index = RUSH_QUESTIONS.findIndex(q => q.id === id);
    if (index !== -1) {
        RUSH_QUESTIONS[index] = { ...req.body, id };
        res.json({ success: true });
    } else res.status(404).json({ error: 'not found' });
});
app.delete('/api/rush-questions/:id', (req, res) => {
    RUSH_QUESTIONS = RUSH_QUESTIONS.filter(q => q.id !== req.params.id);
    res.json({ success: true });
});

app.post('/api/mutual-questions', (req, res) => {
    const q = req.body;
    q.id = 'm' + Date.now();
    MUTUAL_QUESTIONS.push(q);
    res.json({ success: true });
});
app.put('/api/mutual-questions/:id', (req, res) => {
    const id = req.params.id;
    const index = MUTUAL_QUESTIONS.findIndex(q => q.id === id);
    if (index !== -1) {
        MUTUAL_QUESTIONS[index] = { ...req.body, id };
        res.json({ success: true });
    } else res.status(404).json({ error: 'not found' });
});
app.delete('/api/mutual-questions/:id', (req, res) => {
    MUTUAL_QUESTIONS = MUTUAL_QUESTIONS.filter(q => q.id !== req.params.id);
    res.json({ success: true });
});

// ---------- WebSocket ----------
wss.on('connection', (ws) => {
    console.log('客户端连接');
    ws.send(JSON.stringify({ type: 'STATE', state: gameState }));

    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'HOST_ACTION') {
                const { action, payload } = data;
                if (action === 'selectActivity') {
                    if (payload === 'rush') {
                        gameState.currentActivity = 'rush';
                        gameState.rush = { roundState: 'IDLE', currentQuestion: null, rushEndTime: 0, answerEndTime: 0, buzzerPlayerId: null, correctAnswer: null };
                        gameState.lastBuzzWinner = null;
                        gameState.lastAnswerResult = null;
                    } else {
                        gameState.currentActivity = 'mutual';
                        gameState.mutual = {
                            currentDrawTeamId: 0, currentAnswerTeamId: 1,
                            currentQuestion: null, answerEndTime: 0, answeringPlayerId: null,
                            roundActive: false, teamAnswerCount: new Array(gameState.players.length).fill(0), phaseEnded: false
                        };
                        gameState.lastBuzzWinner = null;
                        gameState.lastAnswerResult = null;
                    }
                    broadcastState();
                } else if (action === 'startRush') {
                    if (gameState.currentActivity !== 'rush') return;
                    if (RUSH_QUESTIONS.length === 0) {
                        ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result: { msg: '抢答题库为空' } }));
                        return;
                    }
                    const q = RUSH_QUESTIONS[Math.floor(Math.random() * RUSH_QUESTIONS.length)];
                    gameState.rush.currentQuestion = { ...q };
                    gameState.rush.correctAnswer = q.answer;
                    gameState.rush.roundState = 'RUSHING';
                    gameState.rush.rushEndTime = Date.now() + 40000;
                    gameState.rush.buzzerPlayerId = null;
                    gameState.lastBuzzWinner = null;
                    gameState.lastAnswerResult = null;
                    broadcastState();
                } else if (action === 'drawQuestion') {
                    if (gameState.currentActivity !== 'mutual') return;
                    if (gameState.mutual.roundActive) return;
                    if (payload.drawTeamId !== gameState.mutual.currentDrawTeamId) return;
                    if (MUTUAL_QUESTIONS.length === 0) {
                        ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result: { msg: '互问互答题库为空' } }));
                        return;
                    }
                    const q = MUTUAL_QUESTIONS[Math.floor(Math.random() * MUTUAL_QUESTIONS.length)];
                    gameState.mutual.currentQuestion = { ...q };
                    gameState.mutual.roundActive = true;
                    gameState.mutual.answeringPlayerId = gameState.mutual.currentAnswerTeamId;
                    gameState.mutual.answerEndTime = Date.now() + 80000;
                    gameState.lastAnswerResult = null;
                    broadcastState();
                }
            } else if (data.type === 'PLAYER_RUSH') {
                const rush = gameState.rush;
                if (gameState.currentActivity !== 'rush') return;
                if (rush.roundState !== 'RUSHING') return;
                if (rush.buzzerPlayerId !== null) return;
                if (Date.now() > rush.rushEndTime) return;
                rush.buzzerPlayerId = data.playerId;
                const player = gameState.players.find(p => p.id === data.playerId);
                gameState.lastBuzzWinner = {
                    teamId: player.id,
                    teamName: player.name,
                    timestamp: Date.now(),
                };
                rush.roundState = 'ANSWERING';
                rush.answerEndTime = Date.now() + 6000;
                broadcastState();
                // 4秒后清除抢答者提示
                setTimeout(() => {
                    if (gameState.lastBuzzWinner && gameState.lastBuzzWinner.teamId === player.id) {
                        gameState.lastBuzzWinner = null;
                        broadcastState();
                    }
                }, 4000);
            } else if (data.type === 'PLAYER_ANSWER') {
                if (gameState.currentActivity === 'rush') {
                    const result = handleRushAnswer(data.playerId, data.answerIndex);
                    if (result) ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result }));
                } else {
                    const result = handleMutualAnswer(data.playerId, data.answerIndex);
                    if (result) ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result }));
                }
            } else if (data.type === 'PLAYER_TIMEOUT') {
                // 超时处理（略，同前）
                if (gameState.currentActivity === 'rush' && gameState.rush.roundState === 'ANSWERING') {
                    const p = gameState.players.find(p => p.id === gameState.rush.buzzerPlayerId);
                    if (p) {
                        gameState.rush.roundState = 'FINISHED';
                        gameState.lastAnswerResult = { teamId: p.id, teamName: p.name, isCorrect: false, message: `⏰ ${p.name} 答题超时，不得分` };
                        broadcastState();
                        setTimeout(() => {
                            if (gameState.currentActivity === 'rush' && gameState.rush.roundState === 'FINISHED') {
                                gameState.rush.roundState = 'IDLE';
                                gameState.lastAnswerResult = null;
                                broadcastState();
                            }
                        }, 3000);
                    }
                }
                // mutual 超时类似...
            }
        } catch(e) { console.error(e); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
