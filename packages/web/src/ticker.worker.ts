// A clock for hidden tabs: pages stop requestAnimationFrame and throttle their
// timers in the background, but messages from a dedicated worker keep coming.
setInterval(() => postMessage(performance.now()), 10);
