/**
 * expression-cell
 *
 * A custom element for spreadsheet-like expressions in table cells.
 * Supports formulas, cell references, and automatic computation.
 *
 * Coordinates are automatically inferred from table structure:
 * - Column A = first column, B = second, etc.
 * - Row 1 = first tbody row, 2 = second, etc.
 * - Header references use header text ($price, $amount, etc.)
 *
 * Usage:
 * ```html
 * <table>
 *   <thead>
 *     <tr>
 *       <th>Item</th>
 *       <th>Amount</th>
 *       <th>Total</th>
 *     </tr>
 *   </thead>
 *   <tbody>
 *     <tr>
 *       <td>Item 1</td>
 *       <td>100</td>
 *       <td><expression-cell>=B1*2</expression-cell></td>
 *     </tr>
 *     <tr>
 *       <td>Total</td>
 *       <td><expression-cell>=SUM(B1:B5)</expression-cell></td>
 *       <td><expression-cell>=SUM($amount1:$amount5)</expression-cell></td>
 *     </tr>
 *   </tbody>
 * </table>
 * ```
 */

interface CellValue {
  value: number | string | null;
  formula?: string;
  element?: HTMLElement;
}

interface CellReference {
  col: string;
  row: number;
  header?: string;
  isFixed: boolean;
}

interface CellRange {
  start: CellReference;
  end: CellReference;
}

class TableCache {
  private static instances = new Map<HTMLTableElement, TableCache>();
  private cells = new Map<string, CellValue>();
  private headerMap = new Map<string, string>();
  private table: HTMLTableElement;
  private evaluationStack = new Set<string>();

  private constructor(table: HTMLTableElement) {
    this.table = table;
    this.buildCache();
  }

  static getInstance(table: HTMLTableElement): TableCache {
    if (!TableCache.instances.has(table)) {
      TableCache.instances.set(table, new TableCache(table));
    }
    return TableCache.instances.get(table)!;
  }

  private buildCache(): void {
    this.cells.clear();
    this.headerMap.clear();

    const headerRow = this.table.querySelector("thead tr");
    if (headerRow) {
      Array.from(headerRow.querySelectorAll("th")).forEach((header, colIndex) => {
        const headerText = header.textContent?.trim().toLowerCase().replace(/\s+/g, "");
        if (headerText) {
          this.headerMap.set(headerText, String.fromCharCode(65 + colIndex));
        }
      });
    }

    const tbody = this.table.querySelector("tbody");
    if (!tbody) return;

    Array.from(tbody.querySelectorAll("tr")).forEach((row, rowIndex) => {
      Array.from(row.querySelectorAll("td")).forEach((cell, colIndex) => {
        const key = `${String.fromCharCode(65 + colIndex)}${rowIndex + 1}`;
        const expressionEl = cell.querySelector("expression-cell");

        if (expressionEl) {
          this.cells.set(key, {
            value: null,
            formula:
              expressionEl.getAttribute("data-formula") ||
              expressionEl.textContent?.trim(),
            element: expressionEl as HTMLElement,
          });
        } else {
          const text = cell.textContent?.trim() || "";
          const num = Number.parseFloat(text);
          this.cells.set(key, {
            value: Number.isNaN(num) ? text : num,
            element: cell as HTMLElement,
          });
        }
      });
    });
  }

  refresh(): void {
    this.evaluationStack.clear();
    this.buildCache();
  }

  getCellValue(ref: CellReference): number | string | null {
    const key = this.getCellKey(ref);
    if (!key || this.evaluationStack.has(key)) return null;

    const cell = this.cells.get(key);
    if (!cell) return null;

    if (cell.formula) {
      this.evaluationStack.add(key);
      try {
        return new ExpressionEvaluator(this).evaluate(cell.formula);
      } finally {
        this.evaluationStack.delete(key);
      }
    }

    return cell.value;
  }

  getCellKey(ref: CellReference): string | null {
    let col = ref.col;
    if (ref.header) {
      const mapped = this.headerMap.get(ref.header.toLowerCase());
      if (!mapped) return null;
      col = mapped;
    }
    return `${col}${ref.row}`;
  }

  getRangeValues(range: CellRange): (number | string | null)[] {
    const values: (number | string | null)[] = [];

    let startCol = range.start.col;
    let endCol = range.end.col;

    if (range.start.header) {
      startCol = this.headerMap.get(range.start.header.toLowerCase()) || startCol;
    }
    if (range.end.header) {
      endCol = this.headerMap.get(range.end.header.toLowerCase()) || endCol;
    }

    const startColCode = startCol.charCodeAt(0);
    const endColCode = endCol.charCodeAt(0);

    for (let row = range.start.row; row <= range.end.row; row++) {
      for (let colCode = startColCode; colCode <= endColCode; colCode++) {
        values.push(
          this.getCellValue({ col: String.fromCharCode(colCode), row, isFixed: false }),
        );
      }
    }

    return values;
  }

  getTable(): HTMLTableElement {
    return this.table;
  }
}

class ExpressionEvaluator {
  private cache: TableCache;
  private depth = 0;
  private static readonly MAX_DEPTH = 100;

  constructor(cache: TableCache) {
    this.cache = cache;
  }

  evaluate(expression: string): number | string {
    if (!expression.startsWith("=")) return expression;

    const formula = expression.slice(1).trim();
    if (!formula) return expression;

    try {
      return this.evaluateFormula(formula);
    } catch (error) {
      return `#ERROR: ${error instanceof Error ? error.message : "Invalid formula"}`;
    }
  }

  private evaluateFormula(formula: string): number | string {
    if (++this.depth > ExpressionEvaluator.MAX_DEPTH) {
      throw new Error("Maximum evaluation depth exceeded");
    }

    try {
      const withFunctions = this.replaceFunctions(formula);
      const withReferences = this.replaceReferences(withFunctions);
      return this.evaluateExpression(withReferences);
    } finally {
      this.depth--;
    }
  }

  private replaceReferences(formula: string): string {
    return formula.replace(/(\$?)([a-zA-Z]+)(\d+)/g, (_, dollar, colOrHeader, row) => {
      const value = this.cache.getCellValue({
        col: dollar ? "" : colOrHeader.toUpperCase(),
        row: Number.parseInt(row, 10),
        header: dollar ? colOrHeader : undefined,
        isFixed: dollar === "$",
      });
      const num = this.valueToNumber(value);
      return Number.isNaN(num) ? "0" : num.toString();
    });
  }

  private replaceFunctions(formula: string): string {
    return formula.replace(
      /(SUM|COUNT|AVERAGE|AVG|MIN|MAX)\s*\(([^)]+)\)/gi,
      (_, funcName, args) => {
        return this.evaluateFunction(funcName.toUpperCase(), args.trim()).toString();
      },
    );
  }

  private evaluateFunction(funcName: string, args: string): number {
    const values = this.parseArguments(args);
    const numbers = values
      .map((v) => this.valueToNumber(v))
      .filter((n) => !Number.isNaN(n));

    if (numbers.length === 0) return 0;

    switch (funcName) {
      case "SUM":
        return numbers.reduce((sum, n) => sum + n, 0);
      case "COUNT":
        return numbers.length;
      case "AVERAGE":
      case "AVG":
        return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
      case "MIN":
        return Math.min(...numbers);
      case "MAX":
        return Math.max(...numbers);
      default:
        throw new Error(`Unknown function: ${funcName}`);
    }
  }

  private parseArguments(args: string): (number | string | null)[] {
    const rangeMatch = args.match(/(\$?)([a-zA-Z]+)(\d+):(\$?)([a-zA-Z]+)(\d+)/);

    if (rangeMatch) {
      const [, startDollar, startCol, startRow, endDollar, endCol, endRow] = rangeMatch;
      return this.cache.getRangeValues({
        start: {
          col: startCol.toUpperCase(),
          row: Number.parseInt(startRow, 10),
          header: startDollar === "$" ? startCol : undefined,
          isFixed: startDollar === "$",
        },
        end: {
          col: endCol.toUpperCase(),
          row: Number.parseInt(endRow, 10),
          header: endDollar === "$" ? endCol : undefined,
          isFixed: endDollar === "$",
        },
      });
    }

    return args.split(",").map((arg) => {
      const cellMatch = arg.trim().match(/(\$?)([a-zA-Z]+)(\d+)/);
      if (!cellMatch) return null;

      const [, dollar, colOrHeader, row] = cellMatch;
      return this.cache.getCellValue({
        col: dollar ? "" : colOrHeader.toUpperCase(),
        row: Number.parseInt(row, 10),
        header: dollar ? colOrHeader : undefined,
        isFixed: dollar === "$",
      });
    });
  }

  private valueToNumber(value: number | string | null): number {
    if (value === null) return NaN;
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "" || trimmed === "empty") return NaN;
      return Number.parseFloat(trimmed);
    }
    return NaN;
  }

  private evaluateExpression(expr: string): number {
    expr = expr.trim().replace(/\s+/g, "");
    if (!expr) throw new Error("Empty expression");

    const tokens = this.tokenize(expr);
    if (tokens.length === 0) throw new Error("Invalid expression");

    return this.evaluatePostfix(this.infixToPostfix(tokens));
  }

  private tokenize(expr: string): string[] {
    const tokens: string[] = [];
    let current = "";

    for (const char of expr) {
      if (/[0-9.]/.test(char)) {
        current += char;
      } else if (/[+\-*/()]/.test(char)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
        tokens.push(char);
      } else {
        current += char;
      }
    }

    if (current) tokens.push(current);
    return tokens;
  }

  private infixToPostfix(tokens: string[]): string[] {
    const output: string[] = [];
    const operators: string[] = [];
    const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };

    for (const token of tokens) {
      if (/^-?\d+(\.\d+)?$/.test(token)) {
        output.push(token);
      } else if (token === "(") {
        operators.push(token);
      } else if (token === ")") {
        while (operators.length > 0 && operators[operators.length - 1] !== "(") {
          output.push(operators.pop()!);
        }
        operators.pop();
      } else if (token in precedence) {
        while (
          operators.length > 0 &&
          operators[operators.length - 1] !== "(" &&
          precedence[operators[operators.length - 1]] >= precedence[token]
        ) {
          output.push(operators.pop()!);
        }
        operators.push(token);
      }
    }

    while (operators.length > 0) {
      output.push(operators.pop()!);
    }

    return output;
  }

  private evaluatePostfix(tokens: string[]): number {
    const stack: number[] = [];

    for (const token of tokens) {
      if (/^-?\d+(\.\d+)?$/.test(token)) {
        stack.push(Number.parseFloat(token));
      } else {
        const b = stack.pop();
        const a = stack.pop();

        if (a === undefined || b === undefined) {
          throw new Error("Invalid expression");
        }

        switch (token) {
          case "+":
            stack.push(a + b);
            break;
          case "-":
            stack.push(a - b);
            break;
          case "*":
            stack.push(a * b);
            break;
          case "/":
            if (b === 0) throw new Error("Division by zero");
            stack.push(a / b);
            break;
          default:
            throw new Error(`Unknown operator: ${token}`);
        }
      }
    }

    if (stack.length !== 1) {
      throw new Error("Invalid expression");
    }

    return stack[0];
  }
}

customElements.define(
  "expression-cell",
  class extends HTMLElement {
    cache: TableCache | null = null;
    formula = "";
    observer: MutationObserver | null = null;
    isComputing = false;
    inEditor = false;
    hasCursor = false;
    computedResult = "";
    cursorCheckInterval: number | null = null;
    isRestoringFormula = false;

    isInEditMode(): boolean {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return false;

      const range = selection.getRangeAt(0);
      return this.contains(range.startContainer) || this === range.startContainer;
    }

    connectedCallback() {
      if (this.observer || this.cursorCheckInterval !== null) {
        return;
      }

      const table = this.closest("table");
      if (!table) throw new Error("expression-cell must be inside a table");

      this.cache = TableCache.getInstance(table);
      this.inEditor = !!this.closest(".ProseMirror");

      const savedFormula = this.getAttribute("data-formula");
      if (savedFormula) {
        this.formula = savedFormula;
      } else {
        const content = this.textContent?.trim() || "";
        if (content.startsWith("=")) {
          this.formula = content;
        }
      }

      if (this.inEditor) {
        this.setupEditorMode();
        this.cursorCheckInterval = window.setInterval(
          () => this.checkCursorPosition(),
          100,
        );
      } else if (this.formula) {
        this.compute();
      }

      this.observer = new MutationObserver((mutations) => {
        if (this.isComputing || this.isInEditMode() || this.isRestoringFormula) return;

        const shouldRecompute = mutations.some((m) => {
          if (this.contains(m.target) || m.target === this) return false;
          return true;
        });

        if (shouldRecompute) {
          this.cache?.refresh();
          this.updateDisplay();
        }
      });

      this.observer.observe(table, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    disconnectedCallback() {
      this.observer?.disconnect();
      this.observer = null;

      if (this.cursorCheckInterval !== null) {
        clearInterval(this.cursorCheckInterval);
        this.cursorCheckInterval = null;
      }
    }

    setupEditorMode(): void {
      this.syncFormula();

      const selection = window.getSelection();
      if (selection?.rangeCount) {
        const range = selection.getRangeAt(0);
        this.hasCursor =
          this.contains(range.startContainer) || this === range.startContainer;
      }
    }

    syncFormula(): void {
      const dataFormula = this.getAttribute("data-formula");
      if (dataFormula) {
        this.formula = dataFormula;
      } else {
        const content = this.textContent?.trim() || "";
        if (content.startsWith("=")) {
          this.formula = content;
          this.setAttribute("data-formula", content);
        }
      }
    }

    checkCursorPosition(): void {
      if (!this.inEditor) return;

      const selection = window.getSelection();
      if (!selection?.rangeCount) {
        if (this.hasCursor) {
          this.hasCursor = false;
          this.onCursorLeave();
        }
        return;
      }

      const range = selection.getRangeAt(0);
      const cursorInside =
        this.contains(range.startContainer) || this === range.startContainer;

      if (cursorInside !== this.hasCursor) {
        this.hasCursor = cursorInside;
        cursorInside ? this.onCursorEnter() : this.onCursorLeave();
      }
    }

    onCursorEnter(): void {
      const dataFormula = this.getAttribute("data-formula");
      if (dataFormula) {
        this.formula = dataFormula;
        if (this.textContent !== this.formula) {
          this.isRestoringFormula = true;
          this.textContent = this.formula;
          this.isRestoringFormula = false;
        }
      } else if (this.textContent) {
        this.formula = this.textContent;
      }
    }

    onCursorLeave(): void {
      const content = this.textContent?.trim() || "";
      if (content.startsWith("=")) {
        this.formula = content;
      }

      if (!this.inEditor) {
        this.updateDisplay();
      }
    }

    updateDisplay(): void {
      if (!this.isInEditMode() && !this.inEditor) {
        this.compute();
      }
    }

    compute(): void {
      if (this.isInEditMode() || this.inEditor) return;
      if (!this.cache || !this.formula || this.isComputing) return;

      const formulaContent = this.formula.slice(1).trim();
      if (!formulaContent) return;

      this.isComputing = true;
      try {
        const evaluator = new ExpressionEvaluator(this.cache);
        const result = evaluator.evaluate(this.formula);

        this.computedResult =
          typeof result === "number"
            ? result.toFixed(2).replace(/\.?0+$/, "")
            : String(result);

        if (this.textContent !== this.computedResult) {
          this.textContent = this.computedResult;
        }
      } catch (error) {
        this.computedResult = `#ERROR: ${error instanceof Error ? error.message : "Invalid formula"}`;
        this.textContent = this.computedResult;
      } finally {
        this.isComputing = false;
      }
    }

    save(): void {
      if (this.formula) {
        this.setAttribute("data-formula", this.formula);
      }
    }

    static computeAll(table: HTMLTableElement): void {
      const expressions = table.querySelectorAll("expression-cell");
      const cache = TableCache.getInstance(table);
      cache.refresh();

      for (const expr of expressions) {
        (expr as unknown as { compute?: () => void }).compute?.();
      }
    }
  },
);
