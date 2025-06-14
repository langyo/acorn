import {reservedWords, keywords} from "./identifier.js"
import {types as tt} from "./tokentype.js"
import {lineBreak} from "./whitespace.js"
import {getOptions} from "./options.js"
import {wordsRegexp} from "./util.js"
import {
  SCOPE_TOP, SCOPE_FUNCTION, SCOPE_ASYNC, SCOPE_GENERATOR, SCOPE_SUPER, SCOPE_DIRECT_SUPER,
  SCOPE_ARROW, SCOPE_CLASS_STATIC_BLOCK, SCOPE_CLASS_FIELD_INIT, SCOPE_SWITCH
} from "./scopeflags.js"

export class Parser {
  constructor(options, input, startPos) {
    this.options = options = getOptions(options)
    this.sourceFile = options.sourceFile
    this.keywords = wordsRegexp(keywords[options.ecmaVersion >= 6 ? 6 : options.sourceType === "module" ? "5module" : 5])
    let reserved = ""
    if (options.allowReserved !== true) {
      reserved = reservedWords[options.ecmaVersion >= 6 ? 6 : options.ecmaVersion === 5 ? 5 : 3]
      if (options.sourceType === "module") reserved += " await"
    }
    this.reservedWords = wordsRegexp(reserved)
    let reservedStrict = (reserved ? reserved + " " : "") + reservedWords.strict
    this.reservedWordsStrict = wordsRegexp(reservedStrict)
    this.reservedWordsStrictBind = wordsRegexp(reservedStrict + " " + reservedWords.strictBind)
    this.input = String(input)

    // Used to signal to callers of `readWord1` whether the word
    // contained any escape sequences. This is needed because words with
    // escape sequences must not be interpreted as keywords.
    this.containsEsc = false

    // Set up token state

    // The current position of the tokenizer in the input.
    if (startPos) {
      this.pos = startPos
      this.lineStart = this.input.lastIndexOf("\n", startPos - 1) + 1
      this.curLine = this.input.slice(0, this.lineStart).split(lineBreak).length
    } else {
      this.pos = this.lineStart = 0
      this.curLine = 1
    }

    // Properties of the current token:
    // Its type
    this.type = tt.eof
    // For tokens that include more information than their type, the value
    this.value = null
    // Its start and end offset
    this.start = this.end = this.pos
    // And, if locations are used, the {line, column} object
    // corresponding to those offsets
    this.startLoc = this.endLoc = this.curPosition()

    // Position information for the previous token
    this.lastTokEndLoc = this.lastTokStartLoc = null
    this.lastTokStart = this.lastTokEnd = this.pos

    // The context stack is used to superficially track syntactic
    // context to predict whether a regular expression is allowed in a
    // given position.
    this.context = this.initialContext()
    this.exprAllowed = true

    // Figure out if it's a module code.
    this.inModule = options.sourceType === "module"
    this.strict = this.inModule || this.strictDirective(this.pos)

    // Used to signify the start of a potential arrow function
    this.potentialArrowAt = -1
    this.potentialArrowInForAwait = false

    // Positions to delayed-check that yield/await does not exist in default parameters.
    this.yieldPos = this.awaitPos = this.awaitIdentPos = 0
    // Labels in scope.
    this.labels = []
    // Thus-far undefined exports.
    this.undefinedExports = Object.create(null)

    // If enabled, skip leading hashbang line.
    if (this.pos === 0 && options.allowHashBang && this.input.slice(0, 2) === "#!")
      this.skipLineComment(2)

    // Scope tracking for duplicate variable names (see scope.js)
    this.scopeStack = []
    this.enterScope(
      this.options.sourceType === "commonjs"
        // In commonjs, the top-level scope behaves like a function scope
        ? SCOPE_FUNCTION
        : SCOPE_TOP
    )

    // For RegExp validation
    this.regexpState = null

    // The stack of private names.
    // Each element has two properties: 'declared' and 'used'.
    // When it exited from the outermost class definition, all used private names must be declared.
    this.privateNameStack = []
  }

  parse() {
    let node = this.options.program || this.startNode()
    this.nextToken()
    return this.parseTopLevel(node)
  }

  get inFunction() { return (this.currentVarScope().flags & SCOPE_FUNCTION) > 0 }

  get inGenerator() { return (this.currentVarScope().flags & SCOPE_GENERATOR) > 0 }

  get inAsync() { return (this.currentVarScope().flags & SCOPE_ASYNC) > 0 }

  get canAwait() {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      let {flags} = this.scopeStack[i]
      if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT)) return false
      if (flags & SCOPE_FUNCTION) return (flags & SCOPE_ASYNC) > 0
    }
    return (this.inModule && this.options.ecmaVersion >= 13) || this.options.allowAwaitOutsideFunction
  }

  get allowReturn() {
    if (this.inFunction) return true
    if (this.options.allowReturnOutsideFunction && this.currentVarScope().flags & SCOPE_TOP) return true
    return false
  }

  get allowSuper() {
    const {flags} = this.currentThisScope()
    return (flags & SCOPE_SUPER) > 0 || this.options.allowSuperOutsideMethod
  }

  get allowDirectSuper() { return (this.currentThisScope().flags & SCOPE_DIRECT_SUPER) > 0 }

  get treatFunctionsAsVar() { return this.treatFunctionsAsVarInScope(this.currentScope()) }

  get allowNewDotTarget() {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      let {flags} = this.scopeStack[i]
      if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT) ||
          ((flags & SCOPE_FUNCTION) && !(flags & SCOPE_ARROW))) return true
    }
    return false
  }

  get allowUsing() {
    const {flags} = this.currentScope()
    if (flags & SCOPE_SWITCH) return false
    if (!this.inModule && flags & SCOPE_TOP) return false
    return true
  }

  get inClassStaticBlock() {
    return (this.currentVarScope().flags & SCOPE_CLASS_STATIC_BLOCK) > 0
  }

  static extend(...plugins) {
    let cls = this
    for (let i = 0; i < plugins.length; i++) cls = plugins[i](cls)
    return cls
  }

  static parse(input, options) {
    return new this(options, input).parse()
  }

  static parseExpressionAt(input, pos, options) {
    let parser = new this(options, input, pos)
    parser.nextToken()
    return parser.parseExpression()
  }

  static tokenizer(input, options) {
    return new this(options, input)
  }
}
