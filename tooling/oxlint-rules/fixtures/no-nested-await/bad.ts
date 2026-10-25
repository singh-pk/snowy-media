// expected lines: 3
declare function load(): Promise<number[]>;
export const size = (await load()).length;
