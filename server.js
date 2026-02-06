const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// 讓朋友訪問時看到 index.html
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 當有人連線進來時
io.on('connection', (socket) => {
    console.log('一位玩家連線了！');

    // 接收到「玩家動作」事件
    socket.on('playerAction', (msg) => {
        // 把這個動作廣播給所有人
        io.emit('updateUI', msg);
    });
});

// 優先使用雲端平台分配的 Port，如果沒有則使用 3000
const PORT = process.env.PORT || 3000;

http.listen(PORT, () => {
    console.log(`遊戲伺服器已啟動，連接埠：${PORT}`);
});