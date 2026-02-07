const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 提供靜態檔案
app.use(express.static(path.join(__dirname, 'public')));

// 主路由返回 index.html
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    
    // 檢查檔案是否存在
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        // 檔案不存在時顯示詳細錯誤
        res.status(404).send(`
            <h1>Error: index.html not found</h1>
            <p>Expected location: ${indexPath}</p>
            <p>Current directory: ${__dirname}</p>
            <p>Files in current directory:</p>
            <pre>${fs.readdirSync(__dirname).join('\n')}</pre>
            <p>Please make sure index.html is in the 'public' folder</p>
        `);
    }
});

// 遊戲房間
const rooms = new Map();

// 牌組
const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// 生成房間 ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 建立新牌組
function createDeck() {
    const deck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            deck.push({ suit, rank });
        }
    }
    return shuffleDeck(deck);
}

// 洗牌
function shuffleDeck(deck) {
    const newDeck = [...deck];
    for (let i = newDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
    }
    return newDeck;
}

// 建立遊戲狀態
function createGameState(players) {
    return {
        players: players.map((p, idx) => ({
            ...p,
            cards: [],
            chips: 1000,
            currentBet: 0,
            folded: false,
            hasActed: false,
            position: idx
        })),
        deck: createDeck(),
        communityCards: [],
        pot: 0,
        sidePots: [],
        currentPlayerIdx: 0,
        stage: 'preflop',
        dealerIdx: 0,
        smallBlind: 10,
        bigBlind: 20,
        lastRaiseAmount: 20,
        roundActions: 0
    };
}

// 發牌
function dealCards(gameState) {
    gameState.players.forEach(player => {
        if (!player.folded) {
            player.cards = [gameState.deck.pop(), gameState.deck.pop()];
        }
    });
}

// 發公共牌
function dealCommunityCards(gameState, count) {
    for (let i = 0; i < count; i++) {
        gameState.communityCards.push(gameState.deck.pop());
    }
}

// 開始新回合
function startNewRound(gameState) {
    // 重置玩家狀態
    gameState.players = gameState.players.filter(p => p.chips > 0).map(p => ({
        ...p,
        cards: [],
        currentBet: 0,
        folded: false,
        hasActed: false
    }));

    if (gameState.players.length < 2) {
        return false;
    }

    // 重置遊戲狀態
    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.pot = 0;
    gameState.sidePots = [];
    gameState.stage = 'preflop';
    gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length;
    gameState.lastRaiseAmount = gameState.bigBlind;
    gameState.roundActions = 0;

    // 發牌
    dealCards(gameState);

    // 盲注
    const smallBlindIdx = (gameState.dealerIdx + 1) % gameState.players.length;
    const bigBlindIdx = (gameState.dealerIdx + 2) % gameState.players.length;
    
    gameState.players[smallBlindIdx].currentBet = gameState.smallBlind;
    gameState.players[smallBlindIdx].chips -= gameState.smallBlind;
    gameState.pot += gameState.smallBlind;

    gameState.players[bigBlindIdx].currentBet = gameState.bigBlind;
    gameState.players[bigBlindIdx].chips -= gameState.bigBlind;
    gameState.pot += gameState.bigBlind;
    
    // 翻牌前大盲還沒行動
    gameState.players[bigBlindIdx].hasActed = false;

    // 從大盲後一位開始
    gameState.currentPlayerIdx = (gameState.dealerIdx + 3) % gameState.players.length;

    return true;
}

// 處理玩家行動
function handleAction(gameState, playerId, action, amount = 0) {
    const playerIdx = gameState.players.findIndex(p => p.id === playerId);
    if (playerIdx === -1) {
        return { error: '找不到玩家' };
    }
    
    if (playerIdx !== gameState.currentPlayerIdx) {
        return { error: '不是你的回合' };
    }

    const player = gameState.players[playerIdx];
    if (player.folded) {
        return { error: '你已經棄牌' };
    }

    const maxBet = Math.max(...gameState.players.map(p => p.currentBet));

    switch (action) {
        case 'fold':
            player.folded = true;
            player.hasActed = true;
            break;
            
        case 'check':
            if (player.currentBet < maxBet) {
                return { error: '無法過牌，需要跟注或棄牌' };
            }
            player.hasActed = true;
            break;
            
        case 'call':
            const callAmount = maxBet - player.currentBet;
            if (callAmount === 0) {
                return { error: '請使用過牌' };
            }
            const actualCall = Math.min(callAmount, player.chips);
            player.currentBet += actualCall;
            player.chips -= actualCall;
            gameState.pot += actualCall;
            player.hasActed = true;
            
            // 如果 all-in
            if (player.chips === 0 && actualCall < callAmount) {
                console.log(`${player.name} all-in with ${actualCall}`);
            }
            break;
            
        case 'raise':
            if (amount <= 0) {
                return { error: '加注金額必須大於 0' };
            }
            
            // 計算總共要下注的金額
            const currentBetNeeded = maxBet - player.currentBet;
            const totalRaise = currentBetNeeded + amount;
            
            // 最小加注金額檢查（至少要是上次加注的兩倍）
            if (amount < gameState.lastRaiseAmount) {
                return { error: `最小加注金額為 ${gameState.lastRaiseAmount}` };
            }
            
            const actualRaise = Math.min(totalRaise, player.chips);
            const previousBet = player.currentBet;
            
            player.currentBet += actualRaise;
            player.chips -= actualRaise;
            gameState.pot += actualRaise;
            player.hasActed = true;
            
            // 更新最後加注金額
            gameState.lastRaiseAmount = amount;
            
            // 所有其他玩家需要重新行動
            gameState.players.forEach((p, idx) => {
                if (idx !== playerIdx && !p.folded) {
                    p.hasActed = false;
                }
            });
            
            console.log(`${player.name} raised ${amount}, total bet: ${player.currentBet}`);
            break;
    }

    gameState.roundActions++;

    // 移到下一個玩家
    moveToNextPlayer(gameState);

    // 檢查是否進入下一階段
    if (isRoundComplete(gameState)) {
        advanceStage(gameState);
    }

    return { success: true };
}

// 移到下一個玩家
function moveToNextPlayer(gameState) {
    let nextPlayer = (gameState.currentPlayerIdx + 1) % gameState.players.length;
    let count = 0;
    
    while (gameState.players[nextPlayer].folded && count < gameState.players.length) {
        nextPlayer = (nextPlayer + 1) % gameState.players.length;
        count++;
    }
    
    gameState.currentPlayerIdx = nextPlayer;
}

// 檢查回合是否完成
function isRoundComplete(gameState) {
    const activePlayers = gameState.players.filter(p => !p.folded && p.chips > 0);
    
    // 只剩一個玩家
    if (activePlayers.length === 1) {
        return true;
    }
    
    // 所有玩家都 all-in
    const playersWithChips = gameState.players.filter(p => !p.folded && p.chips > 0);
    if (playersWithChips.length <= 1) {
        return true;
    }

    const maxBet = Math.max(...gameState.players.map(p => p.currentBet));
    
    // 檢查所有未棄牌的玩家：
    // 1. 下注金額等於最大下注 (或 all-in)
    // 2. 已經行動過
    const allPlayersReady = activePlayers.every(p => {
        const betMatches = p.currentBet === maxBet || p.chips === 0;
        return betMatches && p.hasActed;
    });
    
    return allPlayersReady;
}

// 進入下一階段
function advanceStage(gameState) {
    const activePlayers = gameState.players.filter(p => !p.folded);
    
    if (activePlayers.length === 1) {
        endRound(gameState, activePlayers[0]);
        return;
    }

    // 重置每個玩家的下注和行動狀態
    gameState.players.forEach(p => {
        p.currentBet = 0;
        p.hasActed = false;
    });
    
    gameState.roundActions = 0;
    gameState.lastRaiseAmount = gameState.bigBlind;

    switch (gameState.stage) {
        case 'preflop':
            dealCommunityCards(gameState, 3);
            gameState.stage = 'flop';
            break;
        case 'flop':
            dealCommunityCards(gameState, 1);
            gameState.stage = 'turn';
            break;
        case 'turn':
            dealCommunityCards(gameState, 1);
            gameState.stage = 'river';
            break;
        case 'river':
            gameState.stage = 'showdown';
            const winner = determineWinner(gameState);
            endRound(gameState, winner, activePlayers);
            return;
    }

    // 從莊家後第一位開始
    gameState.currentPlayerIdx = (gameState.dealerIdx + 1) % gameState.players.length;
    while (gameState.players[gameState.currentPlayerIdx].folded || gameState.players[gameState.currentPlayerIdx].chips === 0) {
        gameState.currentPlayerIdx = (gameState.currentPlayerIdx + 1) % gameState.players.length;
    }
}

// 決定贏家（完整版牌型判斷）
function determineWinner(gameState) {
    const activePlayers = gameState.players.filter(p => !p.folded);
    
    if (activePlayers.length === 1) {
        return activePlayers[0];
    }
    
    // 評估每個玩家的手牌
    const playerHands = activePlayers.map(player => ({
        player,
        handRank: evaluateHand(player.cards, gameState.communityCards)
    }));
    
    // 排序（最強的在前）
    playerHands.sort((a, b) => compareHands(b.handRank, a.handRank));
    
    // 找出所有同樣強度的玩家（平手）
    const winningRank = playerHands[0].handRank;
    const winners = playerHands.filter(ph => compareHands(ph.handRank, winningRank) === 0);
    
    if (winners.length === 1) {
        return winners[0].player;
    }
    
    // 平手 - 返回所有贏家
    return winners.map(w => w.player);
}

// 評估手牌強度
function evaluateHand(holeCards, communityCards) {
    const allCards = [...holeCards, ...communityCards];
    const cards = allCards.map(c => ({
        rank: getRankValue(c.rank),
        suit: c.suit,
        rankStr: c.rank
    }));
    
    // 生成所有可能的 5 張牌組合
    const combinations = getCombinations(cards, 5);
    let bestHand = null;
    
    for (const combo of combinations) {
        const hand = evaluateFiveCards(combo);
        if (!bestHand || compareHands(hand, bestHand) > 0) {
            bestHand = hand;
        }
    }
    
    return bestHand;
}

// 評估 5 張牌
function evaluateFiveCards(cards) {
    const sorted = cards.sort((a, b) => b.rank - a.rank);
    const ranks = sorted.map(c => c.rank);
    const suits = sorted.map(c => c.suit);
    
    const isFlush = suits.every(s => s === suits[0]);
    const isStraight = checkStraight(ranks);
    const rankCounts = {};
    
    ranks.forEach(r => {
        rankCounts[r] = (rankCounts[r] || 0) + 1;
    });
    
    const counts = Object.values(rankCounts).sort((a, b) => b - a);
    const uniqueRanks = Object.keys(rankCounts).map(Number).sort((a, b) => b - a);
    
    // 皇家同花順
    if (isFlush && isStraight && ranks[0] === 14) {
        return { type: 9, ranks, tiebreaker: ranks };
    }
    
    // 同花順
    if (isFlush && isStraight) {
        return { type: 8, ranks, tiebreaker: ranks };
    }
    
    // 四條
    if (counts[0] === 4) {
        const quad = uniqueRanks.find(r => rankCounts[r] === 4);
        const kicker = uniqueRanks.find(r => rankCounts[r] === 1);
        return { type: 7, ranks, tiebreaker: [quad, kicker] };
    }
    
    // 葫蘆
    if (counts[0] === 3 && counts[1] === 2) {
        const trip = uniqueRanks.find(r => rankCounts[r] === 3);
        const pair = uniqueRanks.find(r => rankCounts[r] === 2);
        return { type: 6, ranks, tiebreaker: [trip, pair] };
    }
    
    // 同花
    if (isFlush) {
        return { type: 5, ranks, tiebreaker: ranks };
    }
    
    // 順子
    if (isStraight) {
        return { type: 4, ranks, tiebreaker: ranks };
    }
    
    // 三條
    if (counts[0] === 3) {
        const trip = uniqueRanks.find(r => rankCounts[r] === 3);
        const kickers = uniqueRanks.filter(r => rankCounts[r] === 1).sort((a, b) => b - a);
        return { type: 3, ranks, tiebreaker: [trip, ...kickers] };
    }
    
    // 兩對
    if (counts[0] === 2 && counts[1] === 2) {
        const pairs = uniqueRanks.filter(r => rankCounts[r] === 2).sort((a, b) => b - a);
        const kicker = uniqueRanks.find(r => rankCounts[r] === 1);
        return { type: 2, ranks, tiebreaker: [...pairs, kicker] };
    }
    
    // 一對
    if (counts[0] === 2) {
        const pair = uniqueRanks.find(r => rankCounts[r] === 2);
        const kickers = uniqueRanks.filter(r => rankCounts[r] === 1).sort((a, b) => b - a);
        return { type: 1, ranks, tiebreaker: [pair, ...kickers] };
    }
    
    // 高牌
    return { type: 0, ranks, tiebreaker: ranks };
}

// 檢查順子
function checkStraight(ranks) {
    const uniqueRanks = [...new Set(ranks)].sort((a, b) => b - a);
    if (uniqueRanks.length < 5) return false;
    
    // 一般順子
    for (let i = 0; i < uniqueRanks.length - 4; i++) {
        if (uniqueRanks[i] - uniqueRanks[i + 4] === 4) {
            return true;
        }
    }
    
    // A-2-3-4-5 (輪子)
    if (uniqueRanks.includes(14) && uniqueRanks.includes(5) && 
        uniqueRanks.includes(4) && uniqueRanks.includes(3) && uniqueRanks.includes(2)) {
        return true;
    }
    
    return false;
}

// 比較兩手牌
function compareHands(hand1, hand2) {
    if (hand1.type !== hand2.type) {
        return hand1.type - hand2.type;
    }
    
    // 同類型，比較 tiebreaker
    for (let i = 0; i < Math.min(hand1.tiebreaker.length, hand2.tiebreaker.length); i++) {
        if (hand1.tiebreaker[i] !== hand2.tiebreaker[i]) {
            return hand1.tiebreaker[i] - hand2.tiebreaker[i];
        }
    }
    
    return 0; // 完全平手
}

// 獲取牌面值
function getRankValue(rank) {
    const values = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
    return values[rank];
}

// 生成組合
function getCombinations(arr, k) {
    if (k === 1) return arr.map(item => [item]);
    const combinations = [];
    for (let i = 0; i < arr.length - k + 1; i++) {
        const head = arr[i];
        const tailCombinations = getCombinations(arr.slice(i + 1), k - 1);
        tailCombinations.forEach(tail => {
            combinations.push([head, ...tail]);
        });
    }
    return combinations;
}

// 計算邊池
function calculateSidePots(gameState) {
    const players = gameState.players.filter(p => !p.folded);
    
    // 如果只有一個玩家，直接返回主池
    if (players.length === 1) {
        return [{
            amount: gameState.pot,
            eligiblePlayers: [players[0].id],
            name: '主池'
        }];
    }
    
    const pots = [];
    const playerBets = players.map(p => ({
        id: p.id,
        bet: p.currentBet,
        folded: p.folded
    })).sort((a, b) => a.bet - b.bet);
    
    let remainingPlayers = players.map(p => p.id);
    let previousLevel = 0;
    
    for (let i = 0; i < playerBets.length; i++) {
        const currentLevel = playerBets[i].bet;
        
        if (currentLevel > previousLevel && remainingPlayers.length > 0) {
            const potAmount = (currentLevel - previousLevel) * remainingPlayers.length;
            
            if (potAmount > 0) {
                pots.push({
                    amount: potAmount,
                    eligiblePlayers: [...remainingPlayers],
                    name: pots.length === 0 ? '主池' : `邊池 ${pots.length}`
                });
            }
            
            previousLevel = currentLevel;
        }
        
        // 移除達到這個級別的玩家（all-in 的玩家）
        if (i < playerBets.length - 1 && playerBets[i].bet === playerBets[i + 1].bet) {
            continue;
        }
        
        // 找出所有在這個級別 all-in 的玩家
        const allInAtThisLevel = playerBets.filter(pb => pb.bet === currentLevel).map(pb => pb.id);
        remainingPlayers = remainingPlayers.filter(id => !allInAtThisLevel.includes(id));
    }
    
    return pots;
}

// 處理玩家確認結果
function handleConfirmResult(gameState, playerId) {
    if (!gameState.waitingForConfirm) {
        return { error: '遊戲未在等待確認狀態' };
    }
    
    if (!gameState.confirmedPlayers.includes(playerId)) {
        gameState.confirmedPlayers.push(playerId);
    }
    
    // 檢查是否所有玩家都確認了
    const activePlayers = gameState.players.filter(p => p.chips > 0);
    if (gameState.confirmedPlayers.length >= activePlayers.length) {
        // 所有玩家都確認了，開始新回合
        gameState.players.forEach(p => delete p.winAmount);
        delete gameState.winners;
        delete gameState.showdownPlayers;
        delete gameState.waitingForConfirm;
        delete gameState.confirmedPlayers;
        delete gameState.pots;
        
        if (startNewRound(gameState)) {
            return { success: true, newRound: true };
        }
    }
    
    return { success: true, newRound: false };
}

// 獲取牌型名稱
function getHandTypeName(type) {
    const names = ['高牌', '一對', '兩對', '三條', '順子', '同花', '葫蘆', '四條', '同花順', '皇家同花順'];
    return names[type] || '未知';
}

// 結束回合
function endRound(gameState, winners, showdownPlayers = null) {
    // winners 可能是單一玩家或陣列
    const winnerArray = Array.isArray(winners) ? winners : [winners];
    
    // 計算邊池
    const pots = calculateSidePots(gameState);
    
    // 分配每個底池給對應的贏家
    winnerArray.forEach(winner => {
        winner.winAmount = 0;
    });
    
    pots.forEach(pot => {
        // 找出這個底池的有效玩家中的贏家
        const eligibleWinners = winnerArray.filter(w => 
            pot.eligiblePlayers.includes(w.id)
        );
        
        if (eligibleWinners.length > 0) {
            const share = Math.floor(pot.amount / eligibleWinners.length);
            const remainder = pot.amount % eligibleWinners.length;
            
            eligibleWinners.forEach((winner, idx) => {
                const winAmount = share + (idx === 0 ? remainder : 0);
                winner.chips += winAmount;
                winner.winAmount = (winner.winAmount || 0) + winAmount;
            });
        }
    });
    
    // 在 showdown 階段，只顯示未棄牌玩家的手牌
    if (showdownPlayers && showdownPlayers.length > 1) {
        gameState.showdownPlayers = showdownPlayers.map(p => ({
            id: p.id,
            name: p.name,
            cards: p.cards,
            handRank: evaluateHand(p.cards, gameState.communityCards)
        }));
    }
    
    gameState.winners = winnerArray.map(w => ({
        id: w.id,
        name: w.name,
        winAmount: w.winAmount
    }));
    
    gameState.pots = pots;
    gameState.waitingForConfirm = true;
    gameState.confirmedPlayers = [];
}

// 廣播遊戲狀態
function broadcastGameState(gameState) {
    const room = Array.from(rooms.values()).find(r => r.gameState === gameState);
    if (!room) return;

    const maxBet = Math.max(...gameState.players.map(p => p.currentBet));

    room.players.forEach(player => {
        const playerState = {
            ...gameState,
            currentPlayer: gameState.players[gameState.currentPlayerIdx]?.id,
            maxBet: maxBet,
            players: gameState.players.map(p => ({
                ...p,
                // 在 showdown 只顯示未棄牌玩家的牌，否則只顯示自己的牌
                cards: (gameState.showdownPlayers && !p.folded) || p.id === player.id ? p.cards : 
                       (p.cards && p.cards.length > 0 ? [{}, {}] : [])
            })),
            // 傳送 showdown 資訊（只包含未棄牌的玩家）
            showdownPlayers: gameState.showdownPlayers,
            winners: gameState.winners,
            pots: gameState.pots,
            waitingForConfirm: gameState.waitingForConfirm,
            confirmedPlayers: gameState.confirmedPlayers,
            hasConfirmed: gameState.confirmedPlayers?.includes(player.id)
        };
        
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
                type: 'gameUpdate',
                gameState: playerState
            }));
        }
    });
}

// WebSocket 連接
wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'join':
                    handleJoin(ws, data);
                    break;
                case 'startGame':
                    handleStartGame(data.roomId);
                    break;
                case 'action':
                    handlePlayerAction(data);
                    break;
                case 'confirmResult':
                    handlePlayerConfirmResult(data);
                    break;
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        // 清理斷線的玩家
        rooms.forEach((room, roomId) => {
            room.players = room.players.filter(p => p.ws !== ws);
            if (room.players.length === 0) {
                rooms.delete(roomId);
            }
        });
    });
});

// 處理加入
function handleJoin(ws, data) {
    let roomId = data.roomId;
    let room;

    if (!roomId || !rooms.has(roomId)) {
        roomId = generateRoomId();
        room = {
            id: roomId,
            players: [],
            gameState: null
        };
        rooms.set(roomId, room);
    } else {
        room = rooms.get(roomId);
    }

    const playerId = Math.random().toString(36).substring(2, 15);
    const player = {
        id: playerId,
        name: data.playerName,
        ws: ws
    };

    room.players.push(player);

    ws.send(JSON.stringify({
        type: 'joined',
        playerId: playerId,
        roomId: roomId
    }));

    // 通知所有玩家
    room.players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({
                type: 'playerJoined',
                players: room.players.map(pl => ({ id: pl.id, name: pl.name }))
            }));
        }
    });
}

// 開始遊戲
function handleStartGame(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.players.length < 2) {
        return;
    }

    const gameState = createGameState(room.players.map(p => ({
        id: p.id,
        name: p.name
    })));

    room.gameState = gameState;
    startNewRound(gameState);

    room.players.forEach(player => {
        if (player.ws.readyState === WebSocket.OPEN) {
            const playerState = {
                ...gameState,
                currentPlayer: gameState.players[gameState.currentPlayerIdx]?.id
            };
            player.ws.send(JSON.stringify({
                type: 'gameStarted',
                gameState: playerState
            }));
        }
    });

    broadcastGameState(gameState);
}

// 處理玩家行動
function handlePlayerAction(data) {
    const room = rooms.get(data.roomId);
    if (!room || !room.gameState) return;

    const result = handleAction(room.gameState, data.playerId, data.action, data.amount);
    
    if (result.error) {
        const player = room.players.find(p => p.id === data.playerId);
        if (player && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
                type: 'error',
                message: result.error
            }));
        }
        return;
    }

    broadcastGameState(room.gameState);
}

// 處理玩家確認結果
function handlePlayerConfirmResult(data) {
    const room = rooms.get(data.roomId);
    if (!room || !room.gameState) return;

    const result = handleConfirmResult(room.gameState, data.playerId);
    
    if (result.error) {
        const player = room.players.find(p => p.id === data.playerId);
        if (player && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
                type: 'error',
                message: result.error
            }));
        }
        return;
    }

    broadcastGameState(room.gameState);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});