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

// 独立的题库
const RUSH_QUESTIONS = [
    { id: 1, type: '选择题', question: '中国的首都是哪个城市？', options: ['上海', '北京', '广州', '深圳'], answer: 1 },
    { id: 2, type: '选择题', question: '地球上最大的海洋是？', options: ['大西洋', '印度洋', '太平洋', '北冰洋'], answer: 2 },
    { id: 3, type: '判断题', question: '光在真空中的速度约为每秒30万公里。', options: ['正确', '错误'], answer: 0 },
    // ... 添加更多抢答题目
];

const MUTUAL_QUESTIONS = [
    { id: 101, type: '选择题', question: '安全知识：灭火器压力表指针在什么区域表示正常？', options: ['红色', '绿色', '黄色', '蓝色'], answer: 1 },
    { id: 102, type: '判断题', question: '电器着火时可以直接用水扑灭。', options: ['正确', '错误'], answer: 1 },
    // ... 添加更多互问互答题目
];

// 全局状态
let gameState = {
    players: PRESET_TEAMS.map(t => ({ ...t })),
    currentActivity: 'rush', // 'rush' 或 'mutual'
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
        teamAnswerCount: new Array(PRESET_TEAMS.length).fill(0), // 记录每个队伍答题次数
        phaseEnded: false,
    },
    correctPoints: 10,
};

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
    }
    rush.roundState = 'FINISHED';
    broadcastState();
    // 3秒后重置
    setTimeout(() => {
        if (gameState.currentActivity === 'rush' && gameState.rush.roundState === 'FINISHED') {
            gameState.rush.roundState = 'IDLE';
            broadcastState();
        }
    }, 3000);
    return { correct: isCorrect, msg: isCorrect ? `✅ 回答正确！ +${gameState.correctPoints}分` : `❌ 回答错误！正确答案是 ${rush.currentQuestion.options[rush.correctAnswer]}` };
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
    // 增加该队伍的答题计数
    mutual.teamAnswerCount[playerId] = (mutual.teamAnswerCount[playerId] || 0) + 1;
    // 结束本轮
    mutual.roundActive = false;
    mutual.currentQuestion = null;
    mutual.answeringPlayerId = null;
    // 检查是否所有队伍都完成了2次答题
    const allDone = mutual.teamAnswerCount.every(count => count >= 2);
    if (allDone) {
        mutual.phaseEnded = true;
        broadcastState();
        setTimeout(() => {
            if (gameState.currentActivity === 'mutual') {
                // 自动重置或提示
                gameState.mutual.phaseEnded = false;
                gameState.mutual.teamAnswerCount.fill(0);
                gameState.currentActivity = 'rush'; // 可选：切回抢答
                broadcastState();
            }
        }, 5000);
    } else {
        // 更新下一个抽题和答题队伍：按顺序找下一个未完成2次答题的队伍作为答题方
        let nextAnswerId = (playerId + 1) % gameState.players.length;
        while (mutual.teamAnswerCount[nextAnswerId] >= 2 && nextAnswerId !== playerId) {
            nextAnswerId = (nextAnswerId + 1) % gameState.players.length;
        }
        mutual.currentAnswerTeamId = nextAnswerId;
        mutual.currentDrawTeamId = nextAnswerId; // 下一轮抽题队与答题队一致？按用户需求：“1号队伍抽题，2号队伍回答” → 抽题队与答题队不同。建议抽题队为上一轮的答题队。更简单：抽题队固定为上一轮答题队，答题队为下一顺序未满2次队伍。
        // 更合理的逻辑：抽题队 = 上一轮答题队，答题队 = 下一个未满2次队伍
        // 但为了简单，先让抽题队等于当前答题队？不，用户要求“1号抽题2号回答”。我们设定抽题队与答题队不同且轮流。
        // 这里保持抽题队 = 当前答题队（即刚答完的队伍）的下一个队伍？为了避免复杂，我们重新生成规则：
        // 重置抽题队为刚答完的队伍，答题队为下一个未满2次队伍。
        mutual.currentDrawTeamId = playerId;
        let next = (playerId + 1) % gameState.players.length;
        while (mutual.teamAnswerCount[next] >= 2 && next !== playerId) {
            next = (next + 1) % gameState.players.length;
        }
        mutual.currentAnswerTeamId = next;
        broadcastState();
    }
    broadcastState();
    return { correct: isCorrect, msg: isCorrect ? `✅ 回答正确！ +${gameState.correctPoints}分` : `❌ 回答错误！正确答案是 ${mutual.currentQuestion.options[mutual.currentQuestion.answer]}` };
}

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
                    if (result) {
                        ws.send(JSON.stringify({ type: 'ANSWER_RESULT', result }));
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
