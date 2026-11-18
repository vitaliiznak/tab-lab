import { basicSetup } from "codemirror";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const colors = HighlightStyle.define([
  {
    tag: [t.keyword, t.function(t.variableName), t.macroName],
    color: "#c3b5ff",
  },
  { tag: [t.string, t.special(t.string)], color: "#b9dfac" },
  { tag: [t.number, t.bool, t.typeName], color: "#f3c787" },
  { tag: t.comment, color: "#95a4b6", fontStyle: "italic" },
]);

export function createEditor(
  parent: HTMLElement,
  file: string,
  doc: string,
  change: (code: string) => void,
) {
  function createState(file: string, doc: string) {
    const isCuda = file === "kernels.cu";
    return EditorState.create({
      doc,
      extensions: [
        basicSetup,
        isCuda ? cpp() : rust(),
        syntaxHighlighting(colors),
        EditorView.contentAttributes.of({
          "aria-label": isCuda
            ? "CUDA kernel source code"
            : file === "build.rs"
              ? "Rust build script"
              : "Rust source code",
          spellcheck: "false",
        }),
        EditorView.theme(
          {
            "&": {
              height: "100%",
              backgroundColor: "transparent",
              color: "#e0e6ee",
            },
            "&.cm-focused": { outline: "none" },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "var(--mono, monospace)",
              fontSize: "13px",
              lineHeight: "1.65",
            },
            ".cm-content": {
              caretColor: "#dfecfd",
              padding: "14px 0",
              minHeight: "100%",
            },
            ".cm-line": { padding: "0 8px" },
            ".cm-gutters": {
              background: "transparent",
              border: "none",
              color: "#8b99ac",
            },
            ".cm-lineNumbers .cm-gutterElement": {
              paddingLeft: "12px",
              paddingRight: "4px",
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: "#ffffff09",
            },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
              backgroundColor: "#4f477e",
            },
            ".cm-cursor": { borderLeftColor: "#dfe7f5" },
          },
          { dark: true },
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) change(update.state.doc.toString());
        }),
      ],
    });
  }
  const view = new EditorView({ parent, state: createState(file, doc) });
  // Each file gets its own editing history, so undo cannot restore the
  // previously viewed file into the current one.
  return {
    view,
    open(file: string, doc: string) {
      view.setState(createState(file, doc));
    },
  };
}
