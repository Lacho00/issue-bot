export function createBatchTimer(ms, onFire) {
  let timer = null;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    get pending() {
      return timer !== null;
    },
    touch() {
      clear();
      timer = setTimeout(() => {
        timer = null;
        onFire();
      }, ms);
    },
    flush() {
      clear();
      return onFire();
    },
    cancel: clear,
  };
}
