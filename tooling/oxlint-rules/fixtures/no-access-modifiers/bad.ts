// expected lines: 3 4
export class Decoder extends EventTarget {
  private frames = 0;
  public count() {
    return this.frames;
  }
}
