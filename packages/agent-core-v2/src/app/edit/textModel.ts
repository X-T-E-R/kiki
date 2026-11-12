import {
  type LineEndingStyle,
  materializeModelText,
  toModelTextView,
} from '#/_base/text/line-endings';

export class TextModel {
  readonly lineEndingStyle: LineEndingStyle;
  readonly text: string;

  constructor(raw: string) {
    const view = toModelTextView(raw);
    this.text = view.text;
    this.lineEndingStyle = view.lineEndingStyle;
  }

  materialize(modelText: string): string {
    return materializeModelText(modelText, this.lineEndingStyle);
  }
}
