// graphql.ts — a small hand-written GraphQL executor for the documents gh and
// github-mcp-server send: viewer/repository/node lookups, issue and pull-request
// reads, the five mutations, __type/__schema introspection, and batched bodies.

import {
  decodeGlobalId,
  globalId,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { errJson, jsonResult, type HandlerResult, type ReqCtx } from './http.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '=', '@', '$', '&', '|']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Syntax Error: unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

type Selection =
  | { kind: 'field'; alias: string | null; name: string; args: Array<{ name: string; value: ValueNode }>; selections: Selection[] }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: Selection[] };

interface VarDef {
  name: string;
  type: string;
  defaultValue: ValueNode | undefined;
}

interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: VarDef[];
  selections: Selection[];
}

interface Fragment {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Syntax Error: unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Syntax Error: expected "${value}" but got ${token.value}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`Syntax Error: expected name${value === undefined ? '' : ` "${value}"`} but got ${token.value}`);
    }
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = token.value as Operation['kind'];
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value;
        const varDefs = this.atPunct('(') ? this.parseVarDefs() : [];
        operations.push({ kind, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Syntax Error: unexpected token ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.atPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): string {
    if (this.atPunct('[')) {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let type = `[${inner}]`;
      if (this.atPunct('!')) {
        this.next();
        type += '!';
      }
      return type;
    }
    const name = this.expectName();
    let type = name;
    if (this.atPunct('!')) {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): Selection[] {
    const selections: Selection[] = [];
    this.expectPunct('{');
    while (!this.atPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek()!;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    if (token.kind !== 'name') throw new Error(`Syntax Error: expected field name but got ${token.value}`);
    const first = this.next().value;
    let alias: string | null = null;
    let name = first;
    if (this.atPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@skip/@include) are parsed and ignored: the suite never sends them.
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
    const selections = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const items: ValueNode[] = [];
          while (!this.atPunct(']')) items.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!this.atPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`Syntax Error: unexpected punctuation ${token.value}`);
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error(`Syntax Error: unexpected token ${token.value}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// schema table (only the types the suite and gh probe)
// ---------------------------------------------------------------------------------------------

interface FieldDef {
  name: string;
  type: string;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT';
  fields?: FieldDef[];
  enumValues?: string[];
  inputFields?: FieldDef[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: 'User' },
      { name: 'repository', type: 'Repository' },
      { name: 'node', type: 'Node' },
      { name: '__type', type: '__Type' },
      { name: '__schema', type: '__Schema' },
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: 'CreateIssuePayload' },
      { name: 'closeIssue', type: 'CloseIssuePayload' },
      { name: 'createPullRequest', type: 'CreatePullRequestPayload' },
      { name: 'mergePullRequest', type: 'MergePullRequestPayload' },
      { name: 'addComment', type: 'AddCommentPayload' },
    ],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'login', type: 'String!' },
      { name: 'id', type: 'ID!' },
      { name: 'name', type: 'String' },
      { name: 'email', type: 'String' },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int!' },
      { name: 'name', type: 'String!' },
      { name: 'nameWithOwner', type: 'String!' },
      { name: 'owner', type: 'User!' },
      { name: 'defaultBranchRef', type: 'Ref' },
      { name: 'viewerPermission', type: 'RepositoryPermission!' },
      { name: 'hasIssuesEnabled', type: 'Boolean!' },
      { name: 'issue', type: 'Issue' },
      { name: 'issues', type: 'IssueConnection!' },
      { name: 'pullRequest', type: 'PullRequest' },
      { name: 'pullRequests', type: 'PullRequestConnection!' },
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int!' },
      { name: 'number', type: 'Int!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'IssueState!' },
      { name: 'url', type: 'URI!' },
      { name: 'comments', type: 'IssueCommentConnection!' },
    ],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int!' },
      { name: 'body', type: 'String!' },
      { name: 'author', type: 'User' },
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int!' },
      { name: 'number', type: 'Int!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'PullRequestState!' },
      { name: 'merged', type: 'Boolean!' },
      { name: 'mergeable', type: 'MergeableState!' },
      { name: 'headRefName', type: 'String!' },
      { name: 'baseRefName', type: 'String!' },
      { name: 'headRefOid', type: 'String' },
      { name: 'baseRefOid', type: 'String' },
      { name: 'files', type: 'PullRequestChangedFileConnection!' },
    ],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: [
      { name: 'path', type: 'String!' },
      { name: 'additions', type: 'Int!' },
      { name: 'deletions', type: 'Int!' },
      { name: 'changeType', type: 'String!' },
    ],
  },
  Ref: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'target', type: 'GitObject' },
    ],
  },
  GitObject: { kind: 'OBJECT', fields: [{ name: 'oid', type: 'String!' }] },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[Issue!]' },
      { name: 'edges', type: '[IssueEdge!]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'Issue' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[IssueComment!]' },
      { name: 'edges', type: '[IssueCommentEdge!]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'IssueComment' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[PullRequest!]' },
      { name: 'edges', type: '[PullRequestEdge!]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'PullRequest' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[PullRequestChangedFile!]' },
      { name: 'edges', type: '[PullRequestChangedFileEdge!]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  PullRequestChangedFileEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'PullRequestChangedFile' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: 'Boolean!' },
      { name: 'hasPreviousPage', type: 'Boolean!' },
      { name: 'startCursor', type: 'String' },
      { name: 'endCursor', type: 'String' },
    ],
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
  CloseIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'commentEdge', type: 'IssueCommentEdge' },
      { name: 'subject', type: 'Issue' },
    ],
  },
  __Schema: {
    kind: 'OBJECT',
    fields: [
      { name: 'queryType', type: '__Type!' },
      { name: 'mutationType', type: '__Type' },
      { name: 'types', type: '[__Type!]!' },
      { name: 'directives', type: '[__Directive!]!' },
    ],
  },
  __Type: {
    kind: 'OBJECT',
    fields: [
      { name: 'kind', type: '__TypeKind!' },
      { name: 'name', type: 'String' },
      { name: 'description', type: 'String' },
      { name: 'fields', type: '[__Field!]' },
      { name: 'enumValues', type: '[__EnumValue!]' },
      { name: 'inputFields', type: '[__InputValue!]' },
      { name: 'ofType', type: '__Type' },
      { name: 'interfaces', type: '[__Type!]' },
      { name: 'possibleTypes', type: '[__Type!]' },
      { name: 'specifiedByURL', type: 'String' },
    ],
  },
  __Field: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'args', type: '[__InputValue!]!' },
      { name: 'type', type: '__Type!' },
      { name: 'isDeprecated', type: 'Boolean!' },
      { name: 'deprecationReason', type: 'String' },
    ],
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'type', type: '__Type!' },
      { name: 'defaultValue', type: 'String' },
    ],
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'isDeprecated', type: 'Boolean!' },
      { name: 'deprecationReason', type: 'String' },
    ],
  },
  __Directive: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'locations', type: '[__DirectiveLocation!]!' },
      { name: 'args', type: '[__InputValue!]!' },
      { name: 'isRepeatable', type: 'Boolean!' },
    ],
  },
  Node: { kind: 'OBJECT', fields: [{ name: 'id', type: 'ID!' }] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'PACKAGE', 'MILESTONE', 'WIKI'],
  },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  __TypeKind: {
    kind: 'ENUM',
    enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
  },
  __DirectiveLocation: {
    kind: 'ENUM',
    enumValues: ['QUERY', 'MUTATION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'],
  },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
    ],
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'issueId', type: 'ID!' },
      { name: 'stateReason', type: 'String' },
    ],
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID!' },
      { name: 'baseRefName', type: 'String!' },
      { name: 'headRefName', type: 'String!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
    ],
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'pullRequestId', type: 'ID!' },
      { name: 'mergeMethod', type: 'PullRequestMergeMethod' },
    ],
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'subjectId', type: 'ID!' },
      { name: 'body', type: 'String!' },
    ],
  },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'field', type: 'IssueOrderField!' },
      { name: 'direction', type: 'OrderDirection!' },
    ],
  },
};

function baseTypeName(type: string): string {
  return type.replace(/[[\]!]/g, '');
}

function fieldDef(typeName: string, fieldName: string): FieldDef | undefined {
  const def = SCHEMA[typeName];
  if (def === undefined || def.fields === undefined) return undefined;
  return def.fields.find((field) => field.name === fieldName);
}

/** The introspection `type` reference for a type string like "[Issue!]!". */
function typeRef(type: string): Record<string, unknown> {
  if (type.endsWith('!')) {
    return { kind: 'NON_NULL', name: null, ofType: typeRef(type.slice(0, -1)) };
  }
  if (type.startsWith('[') && type.endsWith(']')) {
    return { kind: 'LIST', name: null, ofType: typeRef(type.slice(1, -1)) };
  }
  const def = SCHEMA[type];
  return { kind: def?.kind ?? 'OBJECT', name: type, ofType: null };
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

type NodeValue = Record<string, unknown> & { __typename: string };

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function cursorToNumber(cursor: string | null | undefined): number | null {
  if (cursor === null || cursor === undefined) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (!decoded.startsWith('cursor:')) return null;
    const n = Number.parseInt(decoded.slice('cursor:'.length), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
    case 'enum':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArgs(args: Array<{ name: string; value: ValueNode }>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function intArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

class GraphQLError extends Error {}

interface ExecCtx {
  store: Store;
}

function userNode(): NodeValue {
  return { __typename: 'User' };
}

function repoNode(repo: Repo): NodeValue {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): NodeValue {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): NodeValue {
  return { __typename: 'PullRequest', repo, pull };
}

function commentNode(repo: Repo, issue: Issue, comment: Issue['comments'][number]): NodeValue {
  return { __typename: 'IssueComment', repo, issue, comment };
}

function typeNode(name: string): NodeValue {
  return { __typename: '__Type', typeName: name };
}

function connectionNode(
  typename: string,
  nodes: NodeValue[],
  totalCount: number,
  pageInfo: NodeValue,
  edges: NodeValue[],
): NodeValue {
  return { __typename: typename, nodes, totalCount, pageInfo, edges };
}

function edgeNode(typename: string, node: NodeValue, cursor: string): NodeValue {
  return { __typename: typename, node, cursor };
}

function pageInfoNode(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): NodeValue {
  return {
    __typename: 'PageInfo',
    hasNextPage,
    hasPreviousPage: false,
    startCursor,
    endCursor,
  };
}

/** Slice `items` (already ordered) by first/after, returning nodes + pageInfo. */
function paginateConnection<T extends { number: number }>(
  typename: string,
  edgeTypename: string,
  items: T[],
  toNode: (item: T) => NodeValue,
  args: Record<string, unknown>,
): NodeValue {
  const first = intArg(args, 'first');
  const after = cursorToNumber(typeof args.after === 'string' ? args.after : null);
  let start = 0;
  if (after !== null) {
    const index = items.findIndex((item) => item.number === after);
    start = index >= 0 ? index + 1 : items.length;
  }
  const page = first === undefined ? items.slice(start) : items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
  const startCursor = page.length > 0 ? cursorFor(page[0]!.number) : null;
  const nodes = page.map(toNode);
  const edges = page.map((item) => edgeNode(edgeTypename, toNode(item), cursorFor(item.number)));
  return connectionNode(typename, nodes, items.length, pageInfoNode(hasNextPage, endCursor, startCursor), edges);
}

function issueState(issue: Issue): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function resolveNodeById(ctx: ExecCtx, id: string): NodeValue | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'repo') {
    const repoId = Number.parseInt(decoded.parts[0] ?? '', 10);
    const repo = ctx.store.listRepos().find((candidate) => candidate.id === repoId);
    return repo === undefined ? null : repoNode(repo);
  }
  if (decoded.kind === 'issue' || decoded.kind === 'pr' || decoded.kind === 'comment') {
    const repoId = Number.parseInt(decoded.parts[0] ?? '', 10);
    const number = Number.parseInt(decoded.parts[1] ?? '', 10);
    const repo = ctx.store.listRepos().find((candidate) => candidate.id === repoId);
    if (repo === undefined) return null;
    if (decoded.kind === 'issue') {
      const issue = ctx.store.getIssue(repo, number);
      return issue === undefined ? null : issueNode(repo, issue);
    }
    const pull = ctx.store.getPull(repo, number);
    return pull === undefined ? null : pullNode(repo, pull);
  }
  if (decoded.kind === 'user') return userNode();
  return null;
}

/** Resolve one field on a node object. Returns the raw value (scalar, node, or array of nodes). */
function resolveField(ctx: ExecCtx, parent: NodeValue, field: string, args: Record<string, unknown>): unknown {
  const repo = parent.repo as Repo | undefined;
  switch (parent.__typename) {
    case 'User': {
      if (field === 'login') return VIEWER.login;
      if (field === 'id') return globalId('user', VIEWER.id);
      if (field === 'name') return VIEWER.name;
      if (field === 'email') return VIEWER.email;
      break;
    }
    case 'Repository': {
      if (repo === undefined) return null;
      if (field === 'id') return globalId('repo', repo.id);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'owner') return userNode();
      if (field === 'defaultBranchRef') {
        const tip = ctx.store.headTip(repo);
        if (tip === undefined) return null;
        return { __typename: 'Ref', repo, name: repo.defaultBranch, oid: tip };
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'issue') {
        const number = intArg(args, 'number');
        if (number === undefined) return null;
        const issue = ctx.store.getIssue(repo, number);
        return issue === undefined ? null : issueNode(repo, issue);
      }
      if (field === 'issues') {
        let issues = [...repo.issues];
        const states = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state)));
          issues = issues.filter((issue) => wanted.has(issueState(issue)));
        }
        const orderBy = args.orderBy;
        if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
          const order = orderBy as Record<string, unknown>;
          if (order.field === 'CREATED_AT' && order.direction === 'DESC') {
            issues.sort((a, b) => b.number - a.number);
          } else if (order.field === 'CREATED_AT' && order.direction === 'ASC') {
            issues.sort((a, b) => a.number - b.number);
          }
        }
        return paginateConnection('IssueConnection', 'IssueEdge', issues, (issue) => issueNode(repo, issue), args);
      }
      if (field === 'pullRequest') {
        const number = intArg(args, 'number');
        if (number === undefined) return null;
        const pull = ctx.store.getPull(repo, number);
        return pull === undefined ? null : pullNode(repo, pull);
      }
      if (field === 'pullRequests') {
        let pulls = [...repo.pulls];
        const states = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state)));
          pulls = pulls.filter((pull) => wanted.has(pullState(pull)));
        }
        pulls.sort((a, b) => b.number - a.number);
        return paginateConnection('PullRequestConnection', 'PullRequestEdge', pulls, (pull) => pullNode(repo, pull), args);
      }
      break;
    }
    case 'Issue': {
      const issue = parent.issue as Issue | undefined;
      if (issue === undefined || repo === undefined) return null;
      if (field === 'id') return globalId('issue', repo.id, issue.number);
      if (field === 'databaseId') return issue.id;
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'body') return issue.body;
      if (field === 'state') return issueState(issue);
      if (field === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field === 'comments') {
        const items = issue.comments.map((comment) => ({ number: comment.id, comment }));
        return paginateConnection(
          'IssueCommentConnection',
          'IssueCommentEdge',
          items,
          (item) => commentNode(repo, issue, item.comment),
          args,
        );
      }
      break;
    }
    case 'IssueComment': {
      const comment = parent.comment as Issue['comments'][number] | undefined;
      const issue = parent.issue as Issue | undefined;
      if (comment === undefined || issue === undefined || repo === undefined) return null;
      if (field === 'id') return globalId('comment', repo.id, issue.number, comment.id);
      if (field === 'databaseId') return comment.id;
      if (field === 'body') return comment.body;
      if (field === 'author') return userNode();
      break;
    }
    case 'PullRequest': {
      const pull = parent.pull as Pull | undefined;
      if (pull === undefined || repo === undefined) return null;
      if (field === 'id') return globalId('pr', repo.id, pull.number);
      if (field === 'databaseId') return pull.id;
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pullState(pull);
      if (field === 'merged') return pull.merged;
      if (field === 'mergeable') return ctx.store.mergeableOf(repo, pull);
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'headRefOid') return pull.headSha;
      if (field === 'baseRefOid') return pull.baseSha;
      if (field === 'files') {
        const items = pull.files.map((file, index) => ({
          number: index + 1,
          node: { __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED' } as NodeValue,
        }));
        return paginateConnection(
          'PullRequestChangedFileConnection',
          'PullRequestChangedFileEdge',
          items,
          (item) => item.node,
          args,
        );
      }
      break;
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return parent.path ?? null;
      if (field === 'additions') return parent.additions ?? 0;
      if (field === 'deletions') return parent.deletions ?? 0;
      if (field === 'changeType') return parent.changeType ?? 'MODIFIED';
      break;
    }
    case 'Ref': {
      if (field === 'name') return parent.name ?? null;
      if (field === 'target') {
        return typeof parent.oid === 'string' ? { __typename: 'GitObject', oid: parent.oid } : null;
      }
      break;
    }
    case 'GitObject': {
      if (field === 'oid') return parent.oid ?? null;
      break;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return parent.hasNextPage ?? false;
      if (field === 'hasPreviousPage') return parent.hasPreviousPage ?? false;
      if (field === 'startCursor') return parent.startCursor ?? null;
      if (field === 'endCursor') return parent.endCursor ?? null;
      break;
    }
    case '__Type': {
      const typeName = parent.typeName as string | null;
      const def = typeName === null ? undefined : SCHEMA[typeName];
      if (field === 'kind') return (parent.kind as string | undefined) ?? def?.kind ?? 'OBJECT';
      if (field === 'name') return typeName;
      if (field === 'description') return null;
      if (field === 'fields') {
        if (def === undefined || def.fields === undefined) return null;
        return def.fields.map((f) => ({ __typename: '__Field', fieldName: f.name, fieldType: f.type }));
      }
      if (field === 'enumValues') {
        if (def === undefined || def.enumValues === undefined) return null;
        return def.enumValues.map((name) => ({ __typename: '__EnumValue', enumName: name }));
      }
      if (field === 'inputFields') {
        if (def === undefined || def.inputFields === undefined) return null;
        return def.inputFields.map((f) => ({ __typename: '__InputValue', inputName: f.name, inputType: f.type }));
      }
      if (field === 'ofType') return (parent.ofType as NodeValue | null | undefined) ?? null;
      if (field === 'interfaces') return [];
      if (field === 'possibleTypes') return null;
      if (field === 'specifiedByURL') return null;
      break;
    }
    case '__Field': {
      if (field === 'name') return parent.fieldName ?? null;
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') return typeRefNode(parent.fieldType as string);
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case '__InputValue': {
      if (field === 'name') return parent.inputName ?? null;
      if (field === 'description') return null;
      if (field === 'type') return typeRefNode(parent.inputType as string);
      if (field === 'defaultValue') return null;
      break;
    }
    case '__EnumValue': {
      if (field === 'name') return parent.enumName ?? null;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case '__Schema': {
      if (field === 'queryType') return typeNode('Query');
      if (field === 'mutationType') return typeNode('Mutation');
      if (field === 'types') return Object.keys(SCHEMA).sort().map((name) => typeNode(name));
      if (field === 'directives') return [];
      break;
    }
    default: {
      // Payload nodes (CreateIssuePayload, AddCommentPayload, ...) carry their fields
      // directly; connection and edge containers do the same.
      if (field in parent) return parent[field];
      if (field === 'nodes') return (parent.nodes as NodeValue[] | undefined) ?? [];
      if (field === 'edges') return (parent.edges as NodeValue[] | undefined) ?? [];
      if (field === 'pageInfo') return parent.pageInfo ?? null;
      if (field === 'totalCount') return parent.totalCount ?? 0;
      if (field === 'node') return parent.node ?? null;
      if (field === 'cursor') return parent.cursor ?? null;
      break;
    }
  }
  return null;
}

function typeRefNode(type: string): NodeValue {
  if (type.endsWith('!')) {
    return { __typename: '__Type', typeName: null, kind: 'NON_NULL', ofType: typeRefNode(type.slice(0, -1)) };
  }
  if (type.startsWith('[') && type.endsWith(']')) {
    return { __typename: '__Type', typeName: null, kind: 'LIST', ofType: typeRefNode(type.slice(1, -1)) };
  }
  return { __typename: '__Type', typeName: type, kind: SCHEMA[type]?.kind ?? 'OBJECT', ofType: null };
}

/** Project `value` (of GraphQL type `typeName`) through `selections` into a JSON value. */
function project(
  ctx: ExecCtx,
  doc: Document,
  value: unknown,
  typeName: string,
  selections: Selection[],
  variables: Record<string, unknown>,
): unknown {
  if (value === null || value === undefined) return null;
  if (selections.length === 0) return value;
  if (Array.isArray(value)) {
    const itemType = baseTypeName(typeName);
    return value.map((item) => project(ctx, doc, item, itemType, selections, variables));
  }
  if (typeof value !== 'object') return value;
  const node = value as NodeValue;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) throw new GraphQLError(`Unknown fragment "${selection.name}"`);
      const projected = project(ctx, doc, node, fragment.typeCondition, selection.selections, variables);
      if (projected !== null && typeof projected === 'object') Object.assign(out, projected);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== node.__typename) continue;
      const projected = project(ctx, doc, node, selection.typeCondition ?? typeName, selection.selections, variables);
      if (projected !== null && typeof projected === 'object') Object.assign(out, projected);
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = node.__typename;
      continue;
    }
    const def = fieldDef(typeName, selection.name);
    if (def === undefined) throw new GraphQLError(`Cannot query field "${selection.name}" on type "${typeName}"`);
    const args = evalArgs(selection.args, variables);
    const fieldValue = resolveField(ctx, node, selection.name, args);
    out[key] = project(ctx, doc, fieldValue, baseTypeName(def.type), selection.selections, variables);
  }
  return out;
}

/** Validate a selection set against the schema; throws GraphQLError naming the bad field. */
function validate(doc: Document, typeName: string, selections: Selection[]): void {
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) throw new GraphQLError(`Unknown fragment "${selection.name}"`);
      validate(doc, fragment.typeCondition, fragment.selections);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      validate(doc, selection.typeCondition ?? typeName, selection.selections);
      continue;
    }
    if (selection.name === '__typename') continue;
    const def = fieldDef(typeName, selection.name);
    if (def === undefined) throw new GraphQLError(`Cannot query field "${selection.name}" on type "${typeName}"`);
    validate(doc, baseTypeName(def.type), selection.selections);
  }
}

/** Execute one root field of a query or mutation. */
function executeRootField(
  ctx: ExecCtx,
  operation: Operation,
  selection: Extract<Selection, { kind: 'field' }>,
  variables: Record<string, unknown>,
): unknown {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const args = evalArgs(selection.args, variables);
  if (operation.kind === 'mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (selection.name === 'createIssue') {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded?.kind === 'repo'
        ? ctx.store.listRepos().find((candidate) => candidate.id === Number.parseInt(decoded.parts[0] ?? '', 10))
        : undefined;
      if (repo === undefined) throw new GraphQLError('repository not found');
      const created = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if (created.issue === undefined) throw new GraphQLError(created.error ?? 'could not create issue');
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, created.issue) };
    }
    if (selection.name === 'closeIssue') {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded?.kind !== 'issue') throw new GraphQLError('issue not found');
      const repo = ctx.store.listRepos().find((candidate) => candidate.id === Number.parseInt(decoded.parts[0] ?? '', 10));
      const issue = repo === undefined ? undefined : ctx.store.getIssue(repo, Number.parseInt(decoded.parts[1] ?? '', 10));
      if (repo === undefined || issue === undefined) throw new GraphQLError('issue not found');
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) };
    }
    if (selection.name === 'createPullRequest') {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded?.kind === 'repo'
        ? ctx.store.listRepos().find((candidate) => candidate.id === Number.parseInt(decoded.parts[0] ?? '', 10))
        : undefined;
      if (repo === undefined) throw new GraphQLError('repository not found');
      const created = ctx.store.createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if (created.pull === undefined) throw new GraphQLError(created.error ?? 'could not create pull request');
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, created.pull) };
    }
    if (selection.name === 'mergePullRequest') {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded?.kind !== 'pr') throw new GraphQLError('pull request not found');
      const repo = ctx.store.listRepos().find((candidate) => candidate.id === Number.parseInt(decoded.parts[0] ?? '', 10));
      const pull = repo === undefined ? undefined : ctx.store.getPull(repo, Number.parseInt(decoded.parts[1] ?? '', 10));
      if (repo === undefined || pull === undefined) throw new GraphQLError('pull request not found');
      const merged = ctx.store.mergePull(repo, pull);
      if (merged.error !== undefined) throw new GraphQLError(`cannot merge pull request: ${merged.error}`);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
    }
    if (selection.name === 'addComment') {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded?.kind !== 'issue') throw new GraphQLError('issue not found');
      const repo = ctx.store.listRepos().find((candidate) => candidate.id === Number.parseInt(decoded.parts[0] ?? '', 10));
      const issue = repo === undefined ? undefined : ctx.store.getIssue(repo, Number.parseInt(decoded.parts[1] ?? '', 10));
      if (repo === undefined || issue === undefined) throw new GraphQLError('issue not found');
      const comment = ctx.store.addComment(repo, issue, String(input.body ?? ''));
      const edge = edgeNode('IssueCommentEdge', commentNode(repo, issue, comment), cursorFor(comment.id));
      return { __typename: 'AddCommentPayload', commentEdge: edge, subject: issueNode(repo, issue) };
    }
    throw new GraphQLError(`Cannot query field "${selection.name}" on type "Mutation"`);
  }
  void rootType;
  if (selection.name === 'viewer') return userNode();
  if (selection.name === 'repository') {
    const owner = stringArg(args, 'owner');
    const name = stringArg(args, 'name');
    if (owner !== VIEWER.login) return null;
    const repo = ctx.store.getRepo(owner, name);
    return repo === undefined ? null : repoNode(repo);
  }
  if (selection.name === 'node') {
    return resolveNodeById(ctx, stringArg(args, 'id'));
  }
  if (selection.name === '__type') {
    const name = stringArg(args, 'name');
    if (SCHEMA[name] === undefined) return null;
    return typeNode(name);
  }
  if (selection.name === '__schema') {
    return { __typename: '__Schema' };
  }
  throw new GraphQLError(`Cannot query field "${selection.name}" on type "Query"`);
}

/** Expand root-level fragments/inline fragments into plain field selections. */
function flattenRootSelections(doc: Document, rootType: string, selections: Selection[]): Array<Extract<Selection, { kind: 'field' }>> {
  const out: Array<Extract<Selection, { kind: 'field' }>> = [];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection);
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) throw new GraphQLError(`Unknown fragment "${selection.name}"`);
      out.push(...flattenRootSelections(doc, rootType, fragment.selections));
      continue;
    }
    if (selection.typeCondition === null || selection.typeCondition === rootType) {
      out.push(...flattenRootSelections(doc, rootType, selection.selections));
    }
  }
  return out;
}

function executeOperation(
  ctx: ExecCtx,
  doc: Document,
  operation: Operation,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const varValues: Record<string, unknown> = {};
  for (const def of operation.varDefs) {
    if (variables[def.name] !== undefined) varValues[def.name] = variables[def.name];
    else if (def.defaultValue !== undefined) varValues[def.name] = evalValue(def.defaultValue, variables);
    else varValues[def.name] = null;
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  validate(doc, rootType, operation.selections);
  const data: Record<string, unknown> = {};
  for (const selection of flattenRootSelections(doc, rootType, operation.selections)) {
    const key = selection.alias ?? selection.name;
    const value = executeRootField(ctx, operation, selection, varValues);
    const def = fieldDef(rootType, selection.name);
    data[key] = project(ctx, doc, value, def === undefined ? rootType : baseTypeName(def.type), selection.selections, varValues);
  }
  return { data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** POST /api/graphql — one operation or a JSON array of operations (batched). */
export function handleGraphQL(ctx: ReqCtx): HandlerResult {
  if (ctx.jsonError) return errJson(400, 'malformed JSON body');
  const execCtx: ExecCtx = { store: ctx.store };
  const runOne = (body: unknown): Record<string, unknown> => {
    if (!isRecord(body) || typeof body.query !== 'string') {
      return { data: null, errors: [{ message: 'request body must be an object with a query string' }] };
    }
    let doc: Document;
    try {
      doc = new Parser(lex(body.query)).parseDocument();
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Syntax Error' }] };
    }
    const variables = isRecord(body.variables) ? body.variables : {};
    let operation: Operation | undefined;
    if (typeof body.operationName === 'string') {
      operation = doc.operations.find((candidate) => candidate.name === body.operationName);
      if (operation === undefined) {
        return { data: null, errors: [{ message: `Unknown operation named "${body.operationName}"` }] };
      }
    } else if (doc.operations.length === 1) {
      operation = doc.operations[0];
    } else if (doc.operations.length === 0) {
      return { data: null, errors: [{ message: 'no operations in document' }] };
    } else {
      return { data: null, errors: [{ message: 'operationName is required when the document has multiple operations' }] };
    }
    try {
      return executeOperation(execCtx, doc, operation, variables);
    } catch (error) {
      if (error instanceof GraphQLError) {
        return { data: null, errors: [{ message: error.message }] };
      }
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'internal error' }] };
    }
  };
  if (Array.isArray(ctx.json)) {
    return jsonResult(200, ctx.json.map((entry) => runOne(entry)));
  }
  return jsonResult(200, runOne(ctx.json));
}
