const {parentPort} = require("worker_threads");

setInterval(() => {
    parentPort.postMessage('tick');
}, 93);