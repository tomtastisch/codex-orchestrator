const FrozenDate = Date;
const reproducibleTimestamp = Date.UTC(2000, 0, 1, 0, 0, 0);

globalThis.Date = class extends FrozenDate {
    constructor(...args) {
        super(...(args.length === 0 ? [reproducibleTimestamp] : args));
    }

    static now() {
        return reproducibleTimestamp;
    }
};
