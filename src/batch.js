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

// «Eso es todo» / «that's all» cierran el lote, sea cual sea el idioma del bot.
export const isBatchClose = (text) => /^(?:eso es todo|that(?:['’]s| is) all)\.?$/i.test(String(text ?? '').trim());
