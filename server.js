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

// 独立题库（示例数据，可导入覆盖）
const DEFAULT_RUSH_QUESTIONS = [
    { id: 1, type: '选择题', question: '中国的首都是哪个城市？', options: ['上海', '北京', '广州', '深圳'], answer: 1 },
    { id: 2, type: '选择题', question: '地球上最大的海洋是？', options: ['大西洋', '印度洋', '太平洋', '北冰洋'], answer: 2 },
    { id: 3, type: '判断题', question: '光在真空中的速度约为每秒30万公里。', options: ['正确', '错误'], answer: 0 },
];

const DEFAULT_MUTUAL_QUESTIONS = [
    { id: 101, type: '选择题', question: '安全知识：灭火器压力表指针在什么区域表示正常？', options: ['红色', '绿色', '黄色', '蓝色'], answer: 1 },
    { id: 102, type: '判断题', question: '电器着火时可以直接用水扑灭。', options: ['正确', '错误'], answer: 1 },
];

let RUSH_QUESTIONS = [...DEFAULT_RUSH_QUESTIONS];
let MUTUAL_QUESTIONS = [...DEFAULT_MUTUAL_QUESTIONS];

// 全局状态
let gameState = {
    players: PRESET_TEAMS.map(t => ({ ...t })),
    currentActivity: 'rush', // 'rush' 或 'mutual'
    rush: {
        roundState: 'IDLE', // IDLE, RUSHING, ANSWERING, FINISHED
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
};

// 广播状态
function broadcastState() {
    const data = JSON.stringify({ type: 'STATE', state: gameState });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    });
}

// 检查互问互答阶段是否结束（所有队伍回答次数达到2）
function checkMutualPhaseEnd() {
    const allDone = gameState.mutual.teamAnswerCount.every(count => count >= 2);
    if (allDone && !gameState.mutual.phaseEnded) {
        gameState.mutual.phaseEnded = true;
        broadcastState();
        // 5秒后自动重置（可选）
        setTimeout(() => {
            if (gameState.currentActivity === 'mutual' && gameState.mutual.phaseEnded) {
                gameState.mutual.phaseEnded = false;
                gameState.mutual.teamAnswerCount.fill(0);
                gameState.mutual.currentDrawTeamId = 0;
                gameState.mutual.currentAnswerTeamId = 1;
                broadcastState();
            }
        }, 5000);
    }
}

// 处理抢答答题
function handleRushAnswer(playerId, selectedIndex) {
    const rush = gameState.rush;
    if (rush.roundState !== 'ANSWERING') return false;
    if (rush.buzzerPlayerId !== playerId) return false;
    const isCorrect = (selectedIndex === rush.correctAnswer);
    const player = gameState.players.find(p => p.id === playerId);
    if (isCorrect) {
        player.score += gameState.correctPoints;
    }
    rush.roundState = 'FINISHED';
    broadcastState();
    // 3秒后重置到空闲
    setTimeout(() => {
        if (gameState.currentActivity === 'rush' && gameState.rush.roundState === 'FINISHED') {
            gameState.rush.roundState = 'IDLE';
            broadcastState();
        }
    }, 3000);
    return { correct: isCorrect, msg: isCorrect ? `✅ ${player.name} 回答正确！ +${gameState.correctPoints}分` : `❌ ${player.name} 回答错误！正确答案是 ${rush.currentQuestion.options[rush.correctAnswer]}` };
}

// 处理互问互答答题
function handleMutualAnswer(playerId, selectedIndex) {
    const mutual = gameState.mutual;
    if (!mutual.roundActive) return false;
    if (mutual.answeringPlayerId !== playerId) return false;
    if (Date.now() > mutual.answerEndTime) return false; // 已超时，前端会先拦截
    const isCorrect = (selectedIndex === mutual.currentQuestion.answer);
    const player = gameState.players.find(p => p.id === playerId);
    if (isCorrect) {
        player.score += gameState.correctPoints;
    }
    // 增加该队伍的答题计数
    mutual.teamAnswerCount[playerId] = (mutual.teamAnswerCount[playerId] || 0) + 1;
    // 结束本轮
    mutual.roundActive = false;
    mutual.currentQuestion = null;
    mutual.answeringPlayerId = null;
    // 更新下一轮抽题和答题队伍（抽题队为当前答题队，答题队为下一个未满2次的队伍）
    let nextAnswerId = (playerId + 1) % gameState.players.length;
    while (mutual.teamAnswerCount[nextAnswerId] >= 2 && nextAnswerId !== playerId) {
        nextAnswerId = (nextAnswerId + 1) % gameState.players.length;
    }
    mutual.currentDrawTeamId = playerId;       // 抽题队为刚答完的队伍
    mutual.currentAnswerTeamId = nextAnswerId; // 下一答题队伍
    broadcastState();
    checkMutualPhaseEnd();
    return { correct: isCorrect, msg: isCorrect ? `✅ ${player.name} 回答正确！ +${gameState.correctPoints}分` : `❌ ${player.name} 回答错误！正确答案是 ${mutual.currentQuestion.options[mutual.currentQuestion.answer]}` };
}

// WebSocket 连接处理
wss.on('connection', (ws) => {
    console.log('新客户端连接');
    ws.send(JSON.stringify({ type: 'STATE', state: gameState }));

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'HOST_ACTION') {
                const { action, payload } = data;
                if (action === 'selectActivity') {
                    if (payload === 'rush') {
                        gameState.currentActivity = 'rush';
                        gameState.rush = { roundState: 'IDLE', currentQuestion: null, rushEndTime: 0, answerEndTime: 0, buzzerPlayerId: null, correctAnswer: null };
                    } else if (payload === 'mutual') {
                        gameState.currentActivity = 'mutual';
                        gameState.mutual = {
                            currentDrawTeamId: 0,
                            currentAnswerTeamId: 1,
                            currentQuestion: null,
                            answerEndTime: 0,
                            answeringPlayerId: null,
                            roundActive: false,
                            teamAnswerCount: new Array(gameState.players.length).fill(0),
                            phaseEnded: false,
                        };
                    }
                    broadcastState();
                } else if (action === 'startRush') {
                    if (gameState.currentActivity !== 'rush') return;
                    if (RUSH_QUESTIONS.length === 0) {
                        ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result: { msg: '抢答题库为空，请先导入题目' } }));
                        return;
                    }
                    const randomIndex = Math.floor(Math.random() * RUSH_QUESTIONS.length);
                    const question = { ...RUSH_QUESTIONS[randomIndex] };
                    gameState.rush.currentQuestion = question;
                    gameState.rush.correctAnswer = question.answer;
                    gameState.rush.roundState = 'RUSHING';
                    gameState.rush.rushEndTime = Date.now() + 40000;
                    gameState.rush.buzzerPlayerId = null;
                    broadcastState();
                } else if (action === 'drawQuestion') {
                    if (gameState.currentActivity !== 'mutual') return;
                    if (gameState.mutual.roundActive) return;
                    const drawTeamId = payload.drawTeamId;
                    if (drawTeamId !== gameState.mutual.currentDrawTeamId) return;
                    if (MUTUAL_QUESTIONS.length === 0) {
                        ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result: { msg: '互问互答题库为空，请先导入题目' } }));
                        return;
                    }
                    const randomIndex = Math.floor(Math.random() * MUTUAL_QUESTIONS.length);
                    const question = { ...MUTUAL_QUESTIONS[randomIndex] };
                    gameState.mutual.currentQuestion = question;
                    gameState.mutual.roundActive = true;
                    gameState.mutual.answeringPlayerId = gameState.mutual.currentAnswerTeamId;
                    gameState.mutual.answerEndTime = Date.now() + 80000;
                    broadcastState();
                }
            } else if (data.type === 'PLAYER_RUSH') {
                const rush = gameState.rush;
                if (gameState.currentActivity !== 'rush') return;
                if (rush.roundState !== 'RUSHING') return;
                if (rush.buzzerPlayerId !== null) return;
                if (Date.now() > rush.rushEndTime) return;
                rush.buzzerPlayerId = data.playerId;
                rush.roundState = 'ANSWERING';
                rush.answerEndTime = Date.now() + 6000;
                broadcastState();
            } else if (data.type === 'PLAYER_ANSWER') {
                if (gameState.currentActivity === 'rush') {
                    const result = handleRushAnswer(data.playerId, data.answerIndex);
                    if (result) ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result }));
                } else if (gameState.currentActivity === 'mutual') {
                    const result = handleMutualAnswer(data.playerId, data.answerIndex);
                    if (result) ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result }));
                }
            } else if (data.type === 'PLAYER_TIMEOUT') {
                // 处理答题超时（抢答或互问互答）
                if (gameState.currentActivity === 'rush' && gameState.rush.roundState === 'ANSWERING') {
                    const player = gameState.players.find(p => p.id === gameState.rush.buzzerPlayerId);
                    if (player) {
                        gameState.rush.roundState = 'FINISHED';
                        broadcastState();
                        ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result: { msg: `⏰ 答题超时！ ${player.name} 未作答，不得分。` } }));
                        setTimeout(() => {
                            if (gameState.currentActivity === 'rush' && gameState.rush.roundState === 'FINISHED') {
                                gameState.rush.roundState = 'IDLE';
                                broadcastState();
                            }
                        }, 3000);
                    }
                } else if (gameState.currentActivity === 'mutual' && gameState.mutual.roundActive) {
                    const player = gameState.players.find(p => p.id === gameState.mutual.answeringPlayerId);
                    if (player) {
                        // 超时不得分，但增加答题计数
                        gameState.mutual.roundActive = false;
                        gameState.mutual.teamAnswerCount[player.id] = (gameState.mutual.teamAnswerCount[player.id] || 0) + 1;
                        // 更新下一轮队伍
                        let nextAnswerId = (player.id + 1) % gameState.players.length;
                        while (gameState.mutual.teamAnswerCount[nextAnswerId] >= 2 && nextAnswerId !== player.id) {
                            nextAnswerId = (nextAnswerId + 1) % gameState.players.length;
                        }
                        gameState.mutual.currentDrawTeamId = player.id;
                        gameState.mutual.currentAnswerTeamId = nextAnswerId;
                        gameState.mutual.currentQuestion = null;
                        gameState.mutual.answeringPlayerId = null;
                        broadcastState();
                        checkMutualPhaseEnd();
                        ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result: { msg: `⏰ 答题超时！ ${player.name} 未作答，不得分。` } }));
                    }
                }
            } else if (data.type === 'IMPORT_QUESTIONS') {
                // 导入题库
                const { importType, questions } = data;
                if (!Array.isArray(questions)) return;
                if (importType === 'rush') {
                    RUSH_QUESTIONS.length = 0;
                    RUSH_QUESTIONS.push(...questions);
                    ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result: { msg: `✅ 抢答题库已更新，共 ${RUSH_QUESTIONS.length} 题` } }));
                    broadcastState();
                } else if (importType === 'mutual') {
                    MUTUAL_QUESTIONS.length = 0;
                    MUTUAL_QUESTIONS.push(...questions);
                    ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result: { msg: `✅ 互问互答题库已更新，共 ${MUTUAL_QUESTIONS.length} 题` } }));
                    broadcastState();
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