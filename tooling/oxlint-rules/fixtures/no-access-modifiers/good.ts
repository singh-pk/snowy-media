export class Decoder extends EventTarget {
  #frames = 0;

  count() {
    return this.#frames;
  }
}
