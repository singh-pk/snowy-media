declare function load(): Promise<number>;
const loaded = await load();
export const value: number = loaded;
