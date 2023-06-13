const httpServer = require('http').createServer();
const io = require('socket.io')(httpServer, {
    cors: {
        origin: ["http://localhost:4200", "http://192.168.1.2:4200", "192.168.1.2:4200"]
    }
})
const axios = require('axios').default
const crypto = require('crypto');
const { Worker } = require('node:worker_threads');


const DEFAULT_TIME_CONTROL = 25000;
const MAX_SEARCH_RANGE = 200;
const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
const worker = new Worker("./worker.js");
worker.on("message", () => {
    updateTimers();
})

let queue = [];
let rooms = new Map();
setInterval(findQueuePairs, 5000);

io.on("connection", socket => {
    socket.on("check-existing", (params, callback) => {
        socketExistingGame = checkUidInGame(params.userId);
        if (socketExistingGame) {
            callback(socketExistingGame);
        }
    })

    socket.on("join-queue", (params, callback) => {
        if (checkUidInQueue(params.userId) == true) return;
        queue.push({ id: socket.id, rating: params.rating, ratingOffset: 50, uid: params.userId });
        callback({ queueLength: queue.length })
    })

    socket.on("join-room", (params, callback) => {
        socket.join(params.room);
        if (!rooms.get(params.room)) {
            return
        };
        let clr = "spectator";
        if (rooms.get(params.room).whiteId == params.uid) {
            clr = "white";
        }
        if (rooms.get(params.room).blackId == params.uid) {
            clr = "black";
        }
        callback({ color: clr, room: rooms.get(params.room) });
    })

    socket.on("make-move", params => {
        if (!params.room) return;
        if (!rooms.get(params.room)) return;
        rooms.get(params.room).FEN = params.FEN;
        rooms.get(params.room).pastPositions = params.pastPositions;
        params.whiteTime = rooms.get(params.room).whiteTime;
        params.blackTime = rooms.get(params.room).blackTime;
        rooms.get(params.room).whiteTurn = !rooms.get(params.room).whiteTurn;
        socket.to(params.room).emit("new-move", params);
    })

    socket.on("leave-queue", params => {
        removeQueue(socket.id);
    })

    socket.on("game-end", params => {
        endGame(params);
    })

    socket.on("send-message", params => {
        rooms.get(params.room).chat_logs.push({ author: params.author, content: params.content });
        socket.to(params.room).emit("receive-message", params);
    })

    socket.on("offer-draw", params => {
        socket.to(params.room).emit("draw-offered");
    })

    socket.on("disconnect", reason => {
        removeQueue(socket.id);
    })
})

function endGame(params) {
    if (!params.room) return;
    if (!rooms.get(params.room)) return;
    rooms.get(params.room).pastPositions.push(rooms.get(params.room).FEN);
    io.to(params.room).emit("game-ended", params);

    axios.post("http://localhost:3000/game",
        {
            id: params.room,
            result: params.status.result,
            FENS: JSON.stringify(rooms.get(params.room).pastPositions),
            chat_logs: JSON.stringify(rooms.get(params.room).chat_logs),
            white_id: rooms.get(params.room).whiteId,
            black_id: rooms.get(params.room).blackId,
        });

    updateRatings(rooms.get(params.room).whiteId, rooms.get(params.room).blackId, params.status.result);
    rooms.delete(params.room);
}

function updateTimers() {
    rooms.forEach(room => {
        if (room.whiteTurn) {
            if (room.whiteTime >= 100)
                room.whiteTime -= 100;
        }
        else {
            if (room.blackTime >= 100)
                room.blackTime -= 100;
        }
        if (room.whiteTime <= 0) endGame({ room: room.id, status: { result: "Black win", message: "Timeout" } })
        if (room.blackTime <= 0) endGame({ room: room.id, status: { result: "White win", message: "Timeout" } });
    })
}

function checkUidInQueue(uid) {
    let found = false;
    queue.forEach(user => {
        if (user.uid == uid)
            found = true;
    })
    return found;
}

function removeQueue(socketId) {
    for (let i = 0; i < queue.length; i++) {
        if (queue[i].id == socketId) {
            queue.splice(i, 1);
        }
    }
}

function checkUidInGame(uid) {
    let roomResult;
    rooms.forEach(room => {
        if (room.whiteId == uid || room.blackId == uid) {
            roomResult = room;
        }
    })
    return roomResult;
}

async function updateRatings(white_id, black_id, result) {

    let white_player = (await axios.get(`http://localhost:3000/user/id/${white_id}`)).data;
    let black_player = (await axios.get(`http://localhost:3000/user/id/${black_id}`)).data;

    probabilityWhiteWin = 1 / (1 + Math.pow(10, ((black_player.rating - white_player.rating) / 400)));
    probabilityBlackWin = 1 - probabilityWhiteWin;

    let res = 0.5;
    switch (result) {
        case "White win": res = 1; break;
        case "Draw": res = 0.5; break;
        case "Black win": res = 0; break;
    }
    let newWhiteRating = white_player.rating + 20 * (res - probabilityWhiteWin);
    let newBlackRating = black_player.rating + 20 * ((1 - res) - probabilityBlackWin);

    await axios.patch(`http://localhost:3000/user/id/${white_id}`, {
        id: white_id,
        rating: Math.round(newWhiteRating)
    })

    await axios.patch(`http://localhost:3000/user/id/${black_id}`, {
        id: black_id,
        rating: Math.round(newBlackRating)
    })
}

function findQueuePairs() {
    if (queue.length == 0) return;
    for (let i = 0; i < queue.length; i++) {
        for (let j = i + 1; j < queue.length; j++) {
            if (Math.abs(queue[i].rating - queue[j].rating) < Math.min(queue[i].ratingOffset, queue[j].ratingOffset)) {
                let id = crypto.randomUUID();
                if (Math.random() > 0.5) {
                    rooms.set(id, { id: id, whiteId: queue[i].uid, blackId: queue[j].uid, FEN: STARTING_FEN, pastPositions: [], chat_logs: [], whiteTurn: true, whiteTime: DEFAULT_TIME_CONTROL, blackTime: DEFAULT_TIME_CONTROL });
                    io.to(queue[i].id).emit("new-match", { roomId: id, opponentId: queue[j].uid, playingWhite: true });
                    io.to(queue[j].id).emit("new-match", { roomId: id, opponentId: queue[i].uid, playingWhite: false });
                } else {
                    rooms.set(id, { id: id, whiteId: queue[j].uid, blackId: queue[i].uid, FEN: STARTING_FEN, pastPositions: [], chat_logs: [], whiteTurn: true, whiteTime: DEFAULT_TIME_CONTROL, blackTime: DEFAULT_TIME_CONTROL });
                    io.to(queue[i].id).emit("new-match", { roomId: id, opponentId: queue[j].uid, playingWhite: false });
                    io.to(queue[j].id).emit("new-match", { roomId: id, opponentId: queue[i].uid, playingWhite: true });
                }
            }
        }
        if (queue[i]) {
            if (queue[i].ratingOffset < MAX_SEARCH_RANGE) { 
                queue[i].ratingOffset += 10; 
            }
        }
    }
}

httpServer.listen(2112, "192.168.1.2");