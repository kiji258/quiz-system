const express = require('express');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));
app.use(express.json());

// ======================== 预设队伍 ========================
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
];

// ======================== 题库 ========================
let RUSH_QUESTIONS = [
    { id: 'r1', type: '选择题', question: '中国的首都是哪个城市？', options: ['上海', '北京', '广州', '深圳'], answer: 1 },
    { id: 'r2', type: '判断题', question: '光在真空中的速度约为每秒30万公里。', options: ['正确', '错误'], answer: 0 },
];
let MUTUAL_QUESTIONS = [
    { id: 'm1', type: '选择题', question: '灭火器压力表指针在什么区域表示正常？', options: ['红色', '绿色', '黄色', '蓝色'], answer: 1 },
    { id: 'm2', type: '判断题', question: '电器着火时可以直接用水扑灭。', options: ['正确', '错误'], answer: 1 },
];

// ======================== 辅助数据 ========================
let teamMembers = {};
PRESET_TEAMS.forEach(t => { teamMembers[t.id] = []; });
let answerHistory = [];

function addHistoryRecord(activityType, teamId, teamName, playerName, question, selectedAnswer, isCorrect, scoreDelta) {
    answerHistory.unshift({
        id: Date.now() + Math.random(),
        timestamp: new Date().toISOString(),
        activityType, teamId, teamName,
        playerName: playerName || '未知',
        question: question.question,
        selectedAnswer,
        isCorrect,
        scoreDelta,
    });
    if (playerName && !teamMembers[teamId].includes(playerName)) {
        teamMembers[teamId].push(playerName);
    }
    if (answerHistory.length > 500) answerHistory.pop();
}

// ======================== 游戏状态 ========================
let gameState = {
    players: PRESET_TEAMS.map(t => ({ ...t, score: 0 })),
    currentActivity: 'rush',
    rush: {
        roundState: 'IDLE',           // IDLE | RUSHING | ANSWERING | FINISHED
        currentQuestion: null,
        rushEndTime: 0,
        answerEndTime: 0,
        buzzerPlayerId: null,
        buzzerPlayerName: null,
        correctAnswer: null,
        usedQuestionIds: [],          // 已使用的题目ID
        rushTimer: null,              // 服务端抢答超时定时器
        answerTimer: null,            // 服务端答题超时定时器
    },
    mutual: {
        currentDrawTeamId: 0,
        currentAnswerTeamId: 1,
        currentQuestion: null,
        answerEndTime: 0,
        answeringPlayerId: null,
        answeringPlayerName: null,
        roundActive: false,
        teamAnswerCount: new Array(PRESET_TEAMS.length).fill(0),
        phaseEnded: false,
        usedQuestionIds: [],          // 已使用题目
        answerTimer: null,            // 服务端答题超时定时器
    },
    correctPoints: 10,
    lastBuzzWinner: null,
    lastAnswerResult: null,
};

// 广播状态
function broadcastState() {
    const data = JSON.stringify({ type: 'STATE', state: gameState });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    });
}

// 清除所有定时器（辅助）
function clearRushTimers() {
    if (gameState.rush.rushTimer) clearTimeout(gameState.rush.rushTimer);
    if (gameState.rush.answerTimer) clearTimeout(gameState.rush.answerTimer);
    gameState.rush.rushTimer = null;
    gameState.rush.answerTimer = null;
}
function clearMutualTimer() {
    if (gameState.mutual.answerTimer) clearTimeout(gameState.mutual.answerTimer);
    gameState.mutual.answerTimer = null;
}

// 从题库中随机抽题（排除已用）
function getRandomQuestion(pool, usedIds) {
    let available = pool.filter(q => !usedIds.includes(q.id));
    if (available.length === 0) {
        // 全部用过则重置（可改为提示题库耗尽）
        usedIds.length = 0;
        available = [...pool];
    }
    const q = available[Math.floor(Math.random() * available.length)];
    usedIds.push(q.id);
    return { ...q };
}

// ======================== 抢答逻辑 ========================
function startRushTimeout() {
    clearRushTimers();
    gameState.rush.rushTimer = setTimeout(() => {
        if (gameState.currentActivity === 'rush' && gameState.rush.roundState === 'RUSHING') {
            // 无人抢答超时
            gameState.rush.roundState = 'FINISHED';
            gameState.lastAnswerResult = {
                teamId: null,
                teamName: '系统',
                message: '⏰ 抢答时间到，无人抢答',
                timestamp: Date.now()
            };
            broadcastState();
            // 3秒后恢复空闲
            setTimeout(() => {
                if (gameState.currentActivity === 'rush' && gameState.rush.roundState === 'FINISHED') {
                    gameState.rush.roundState = 'IDLE';
                    gameState.lastAnswerResult = null;
                    broadcastState();
                }
            }, 3000);
        }
    }, 40000);
}

function startAnswerTimeout() {
    clearRushTimers();
    gameState.rush.answerTimer = setTimeout(() => {
        if (gameState.currentActivity === 'rush' && gameState.rush.roundState === 'ANSWERING') {
            // 答题超时，视为错误
            const playerId = gameState.rush.buzzerPlayerId;
            const playerName = gameState.rush.buzzerPlayerName;
            const player = gameState.players.find(p => p.id === playerId);
            if (player) {
                gameState.rush.roundState = 'FINISHED';
                gameState.lastAnswerResult = {
                    teamId: player.id,
                    teamName: player.name,
                    playerName: playerName,
                    isCorrect: false,
                    message: `⏰ ${player.name}（${playerName}）答题超时，不得分`,
                    timestamp: Date.now()
                };
                broadcastState();
                // 2秒后恢复空闲
                setTimeout(() => {
                    if (gameState.currentActivity === 'rush' && gameState.rush.roundState === 'FINISHED') {
                        gameState.rush.roundState = 'IDLE';
                        gameState.lastAnswerResult = null;
                        broadcastState();
                    }
                }, 2000);
            }
        }
    }, 6000);
}

function skipCurrentRush() {
    clearRushTimers();
    if (gameState.rush.currentQuestion) {
        gameState.rush.usedQuestionIds.push(gameState.rush.currentQuestion.id);
    }
    gameState.rush.roundState = 'FINISHED';
    gameState.lastAnswerResult = {
        teamId: null,
        teamName: '主持人',
        message: '⏭ 主持人跳过本题',
        timestamp: Date.now()
    };
    broadcastState();
    setTimeout(() => {
        if (gameState.currentActivity === 'rush' && gameState.rush.roundState === 'FINISHED') {
            gameState.rush.roundState = 'IDLE';
            gameState.lastAnswerResult = null;
            broadcastState();
        }
    }, 2000);
}

function handleRushAnswer(playerId, playerName, selectedIndex) {
    const rush = gameState.rush;
    if (rush.roundState !== 'ANSWERING') return false;
    if (rush.buzzerPlayerId !== playerId) return false;
    clearRushTimers();

    const isCorrect = (selectedIndex === rush.correctAnswer);
    const player = gameState.players.find(p => p.id === playerId);
    let scoreDelta = 0;
    if (isCorrect) {
        scoreDelta = gameState.correctPoints;
        player.score += scoreDelta;
    }
    addHistoryRecord('rush', playerId, player.name, playerName, rush.currentQuestion, rush.currentQuestion.options[selectedIndex], isCorrect, scoreDelta);
    rush.roundState = 'FINISHED';
    gameState.lastAnswerResult = {
        teamId: playerId,
        teamName: player.name,
        playerName: playerName,
        isCorrect,
        message: isCorrect ? `✅ ${player.name}（${playerName}）回答正确！ +${scoreDelta}分` : `❌ ${player.name}（${playerName}）回答错误！正确答案是 ${rush.currentQuestion.options[rush.correctAnswer]}`,
        timestamp: Date.now(),
    };
    broadcastState();
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

// ======================== 互问互答逻辑 ========================
function startMutualAnswerTimeout() {
    clearMutualTimer();
    gameState.mutual.answerTimer = setTimeout(() => {
        if (gameState.currentActivity === 'mutual' && gameState.mutual.roundActive) {
            const pId = gameState.mutual.answeringPlayerId;
            const pName = gameState.mutual.answeringPlayerName;
            const player = gameState.players.find(p => p.id === pId);
            if (player) {
                gameState.mutual.roundActive = false;
                gameState.mutual.teamAnswerCount[pId] = (gameState.mutual.teamAnswerCount[pId] || 0) + 1;
                gameState.lastAnswerResult = {
                    teamId: pId,
                    teamName: player.name,
                    playerName: pName,
                    isCorrect: false,
                    message: `⏰ ${player.name}（${pName}）答题超时，不得分`,
                    timestamp: Date.now()
                };
                advanceMutualTurn(pId);
                broadcastState();
                setTimeout(() => {
                    if (gameState.lastAnswerResult && gameState.lastAnswerResult.teamId === pId) {
                        gameState.lastAnswerResult = null;
                        broadcastState();
                    }
                }, 4000);
            }
        }
    }, 80000);
}

function advanceMutualTurn(answeredTeamId) {
    const mutual = gameState.mutual;
    // 检查是否所有队伍都已答满2次
    const allAnsweredTwice = mutual.teamAnswerCount.every(count => count >= 2);
    if (allAnsweredTwice) {
        mutual.phaseEnded = true;
        return;
    }
    // 下一个答题队伍
    let nextAnswerId = (answeredTeamId + 1) % gameState.players.length;
    let safety = 0;
    while (mutual.teamAnswerCount[nextAnswerId] >= 2 && safety < gameState.players.length) {
        nextAnswerId = (nextAnswerId + 1) % gameState.players.length;
        safety++;
    }
    mutual.currentDrawTeamId = answeredTeamId;
    mutual.currentAnswerTeamId = nextAnswerId;
    mutual.currentQuestion = null;
    mutual.answeringPlayerId = null;
    mutual.answeringPlayerName = null;
    mutual.roundActive = false;
}

function handleMutualAnswer(playerId, playerName, selectedIndex) {
    const mutual = gameState.mutual;
    if (!mutual.roundActive) return false;
    if (mutual.answeringPlayerId !== playerId) return false;
    if (Date.now() > mutual.answerEndTime) return false;
    clearMutualTimer();

    const isCorrect = (selectedIndex === mutual.currentQuestion.answer);
    const player = gameState.players.find(p => p.id === playerId);
    let scoreDelta = 0;
    if (isCorrect) {
        scoreDelta = gameState.correctPoints;
        player.score += scoreDelta;
    }
    addHistoryRecord('mutual', playerId, player.name, playerName, mutual.currentQuestion, mutual.currentQuestion.options[selectedIndex], isCorrect, scoreDelta);
    mutual.teamAnswerCount[playerId] = (mutual.teamAnswerCount[playerId] || 0) + 1;
    mutual.roundActive = false;
    mutual.currentQuestion = null;
    gameState.lastAnswerResult = {
        teamId: playerId,
        teamName: player.name,
        playerName: playerName,
        isCorrect,
        message: isCorrect ? `✅ ${player.name}（${playerName}）回答正确！ +${scoreDelta}分` : `❌ ${player.name}（${playerName}）回答错误！正确答案是 ${mutual.currentQuestion.options[mutual.currentQuestion.answer]}`,
        timestamp: Date.now(),
    };
    advanceMutualTurn(playerId);
    broadcastState();
    setTimeout(() => {
        if (gameState.lastAnswerResult && gameState.lastAnswerResult.teamId === playerId) {
            gameState.lastAnswerResult = null;
            broadcastState();
        }
    }, 4000);
    return { correct: isCorrect, msg: gameState.lastAnswerResult.message };
}

// ======================== HTTP API ========================
app.get('/api/rush-questions', (req, res) => res.json(RUSH_QUESTIONS));
app.get('/api/mutual-questions', (req, res) => res.json(MUTUAL_QUESTIONS));
app.get('/api/history', (req, res) => res.json(answerHistory));
app.get('/api/team-members', (req, res) => res.json(teamMembers));
app.post('/api/team-members/:teamId', (req, res) => {
    const teamId = parseInt(req.params.teamId);
    const { playerName } = req.body;
    if (!teamMembers[teamId]) teamMembers[teamId] = [];
    if (playerName && !teamMembers[teamId].includes(playerName)) teamMembers[teamId].push(playerName);
    res.json({ success: true });
});
app.delete('/api/team-members/:teamId', (req, res) => {
    const teamId = parseInt(req.params.teamId);
    const { playerName } = req.body;
    if (teamMembers[teamId]) teamMembers[teamId] = teamMembers[teamId].filter(n => n !== playerName);
    res.json({ success: true });
});

app.post('/api/rush-questions', (req, res) => { const q = req.body; q.id = 'r' + Date.now(); RUSH_QUESTIONS.push(q); res.json({ success: true }); });
app.put('/api/rush-questions/:id', (req, res) => { const id = req.params.id; const i = RUSH_QUESTIONS.findIndex(q => q.id === id); if (i !== -1) { RUSH_QUESTIONS[i] = { ...req.body, id }; res.json({ success: true }); } else res.status(404).json({ error: 'not found' }); });
app.delete('/api/rush-questions/:id', (req, res) => { RUSH_QUESTIONS = RUSH_QUESTIONS.filter(q => q.id !== req.params.id); res.json({ success: true }); });

app.post('/api/mutual-questions', (req, res) => { const q = req.body; q.id = 'm' + Date.now(); MUTUAL_QUESTIONS.push(q); res.json({ success: true }); });
app.put('/api/mutual-questions/:id', (req, res) => { const id = req.params.id; const i = MUTUAL_QUESTIONS.findIndex(q => q.id === id); if (i !== -1) { MUTUAL_QUESTIONS[i] = { ...req.body, id }; res.json({ success: true }); } else res.status(404).json({ error: 'not found' }); });
app.delete('/api/mutual-questions/:id', (req, res) => { MUTUAL_QUESTIONS = MUTUAL_QUESTIONS.filter(q => q.id !== req.params.id); res.json({ success: true }); });

// ======================== WebSocket ========================
wss.on('connection', (ws) => {
    console.log('客户端连接');
    ws.send(JSON.stringify({ type: 'STATE', state: gameState }));

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'HOST_ACTION') {
                const { action, payload } = data;
                if (action === 'selectActivity') {
                    clearRushTimers(); clearMutualTimer();
                    if (payload === 'rush') {
                        gameState.currentActivity = 'rush';
                        gameState.rush = {
                            roundState: 'IDLE', currentQuestion: null, rushEndTime: 0, answerEndTime: 0,
                            buzzerPlayerId: null, buzzerPlayerName: null, correctAnswer: null,
                            usedQuestionIds: [], rushTimer: null, answerTimer: null
                        };
                    } else {
                        gameState.currentActivity = 'mutual';
                        gameState.mutual = {
                            currentDrawTeamId: 0, currentAnswerTeamId: 1,
                            currentQuestion: null, answerEndTime: 0, answeringPlayerId: null, answeringPlayerName: null,
                            roundActive: false, teamAnswerCount: new Array(gameState.players.length).fill(0),
                            phaseEnded: false, usedQuestionIds: [], answerTimer: null
                        };
                    }
                    gameState.lastBuzzWinner = null;
                    gameState.lastAnswerResult = null;
                    broadcastState();
                } else if (action === 'startRush') {
                    if (gameState.currentActivity !== 'rush') return;
                    if (RUSH_QUESTIONS.length === 0) return;
                    clearRushTimers();
                    const q = getRandomQuestion(RUSH_QUESTIONS, gameState.rush.usedQuestionIds);
                    gameState.rush.currentQuestion = q;
                    gameState.rush.correctAnswer = q.answer;
                    gameState.rush.roundState = 'RUSHING';
                    gameState.rush.rushEndTime = Date.now() + 40000;
                    gameState.rush.buzzerPlayerId = null;
                    gameState.rush.buzzerPlayerName = null;
                    gameState.lastBuzzWinner = null;
                    gameState.lastAnswerResult = null;
                    startRushTimeout();
                    broadcastState();
                } else if (action === 'skipRush') {
                    if (gameState.currentActivity === 'rush' && (gameState.rush.roundState === 'RUSHING' || gameState.rush.roundState === 'ANSWERING')) {
                        skipCurrentRush();
                    }
                } else if (action === 'drawQuestion') {
                    if (gameState.currentActivity !== 'mutual') return;
                    if (gameState.mutual.roundActive || gameState.mutual.phaseEnded) return;
                    if (payload.drawTeamId !== gameState.mutual.currentDrawTeamId) return;
                    if (MUTUAL_QUESTIONS.length === 0) return;
                    clearMutualTimer();
                    const q = getRandomQuestion(MUTUAL_QUESTIONS, gameState.mutual.usedQuestionIds);
                    gameState.mutual.currentQuestion = q;
                    gameState.mutual.roundActive = true;
                    gameState.mutual.answeringPlayerId = gameState.mutual.currentAnswerTeamId;
                    gameState.mutual.answeringPlayerName = null;
                    gameState.mutual.answerEndTime = Date.now() + 80000;
                    gameState.lastAnswerResult = null;
                    startMutualAnswerTimeout();
                    broadcastState();
                }
            } else if (data.type === 'PLAYER_RUSH') {
                const rush = gameState.rush;
                if (gameState.currentActivity !== 'rush') return;
                if (rush.roundState !== 'RUSHING') return;
                if (rush.buzzerPlayerId !== null) return;
                if (Date.now() > rush.rushEndTime) return;
                clearRushTimers();
                rush.buzzerPlayerId = data.playerId;
                rush.buzzerPlayerName = data.playerName;
                const player = gameState.players.find(p => p.id === data.playerId);
                gameState.lastBuzzWinner = {
                    teamId: player.id,
                    teamName: player.name,
                    playerName: data.playerName,
                    timestamp: Date.now(),
                };
                rush.roundState = 'ANSWERING';
                rush.answerEndTime = Date.now() + 6000;
                startAnswerTimeout();
                broadcastState();
                setTimeout(() => {
                    if (gameState.lastBuzzWinner && gameState.lastBuzzWinner.teamId === player.id) {
                        gameState.lastBuzzWinner = null;
                        broadcastState();
                    }
                }, 4000);
            } else if (data.type === 'PLAYER_ANSWER') {
                let result;
                if (gameState.currentActivity === 'rush') {
                    result = handleRushAnswer(data.playerId, data.playerName, data.answerIndex);
                } else {
                    result = handleMutualAnswer(data.playerId, data.playerName, data.answerIndex);
                }
                if (result) ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result }));
            }
            // PLAYER_TIMEOUT 现已不再需要，所有超时由服务端定时器处理，但保留以防手动触发
        } catch(e) { console.error(e); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
