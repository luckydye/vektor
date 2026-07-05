---
title: Add or edit notes/shapes on a canvas document
keywords: canvas, note, shape, sticky, stroke, board
---

Canvas documents are JSON: {version, shapes: [...], strokes: [...]}.
Each shape: {id, type: "note"|"text"|"image"|"section", x, y, width, height, text, color}.
1. Read the canvas to see existing shapes and pick a free x/y spot:
   Call `get_current_document`, or `read_document` with a document ID.
2. Add a note (id must be unique — use a suffix like the current timestamp):
   `edit_document` operation: {"op":"push","path":".shapes","value":{"id":"shape-note-1718000000","type":"note","x":300,"y":100,"width":240,"height":150,"text":"Hello","color":"#fef3c7"}}
3. Edit or remove by array index from the read output:
   `edit_document` operation: {"op":"set","path":".shapes[2].text","value":"updated text"}
   `edit_document` operation: {"op":"unset","path":".shapes[2]"}
Changes appear live for users viewing the canvas. Note colors: #fef3c7 yellow,
#dbeafe blue, #fee2e2 red, #fae8ff purple, #fff7ed orange.
