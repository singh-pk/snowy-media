// expected lines: 3
declare function load(): Promise<unknown>;
export const value = (await load()) as number;
