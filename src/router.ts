import type {
  RadixRouterContext,
  RadixNode,
  MatchedRoute,
  RadixRouter,
  RadixNodeData,
  RadixRouterOptions,
} from "./types";
import { NODE_TYPES } from "./types";

export function createRouter<T extends RadixNodeData = RadixNodeData>(
  options: RadixRouterOptions = {},
): RadixRouter<T> {
  const ctx: RadixRouterContext = {
    options,
    rootNode: createRadixNode(),
    staticRoutesMap: {},
  };

  const normalizeTrailingSlash = (p) =>
    options.strictTrailingSlash ? p : p.replace(/\/$/, "") || "/";

  if (options.routes) {
    for (const path in options.routes) {
      insert(ctx, normalizeTrailingSlash(path), options.routes[path]);
    }
  }

  return {
    ctx,
    // @ts-ignore
    lookup: (path: string) => lookup(ctx, normalizeTrailingSlash(path)),
    insert: (path: string, data: any) =>
      insert(ctx, normalizeTrailingSlash(path), data),
    remove: (path: string) => remove(ctx, normalizeTrailingSlash(path)),
  };
}

function lookup(ctx: RadixRouterContext, path: string): MatchedRoute {
  /** 先从静态路由中查找 */
  const staticPathNode = ctx.staticRoutesMap[path];
  if (staticPathNode) {
    return staticPathNode.data;
  }

  /** 再从动态路由中查找 */ 
  const sections = path.split("/");

  // 动态参数名称
  const params: MatchedRoute["params"] = {};
  let paramsFound = false;
  let wildcardNode = null;
  let node = ctx.rootNode;
  let wildCardParam = null;

  // 按/拆解，查找radix tree
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];

    // 泛子节点
    if (node.wildcardChildNode !== null) {
      wildcardNode = node.wildcardChildNode;
      // 泛节点参数值
      // 比如/path/**:xx 匹配/path/a/b时，xx即为a/b
      wildCardParam = sections.slice(i).join("/");
    }

    // Exact matches take precedence over placeholders
    const nextNode = node.children.get(section);
    // 非普通节点
    if (nextNode === undefined) {
      node = node.placeholderChildNode;
      if (node === null) {
        break;
      // 动态子节点
      } else {
        // 混合子节点
        if (node.type === NODE_TYPES.MIXED && node.paramMatcher) {
          const matches = section.match(node.paramMatcher);
          // 动态路由值
          Object.assign(params, matches.groups);
        // 动态子节点
        } else {
          // 动态路由值
          params[node.paramName] = section;
        }
        paramsFound = true;
      }
    // 普通子节点
    } else {
      node = nextNode;
    }
  }

  // 不是普通节点，查找泛节点参数值
  // node.data ??
  if ((node === null || node.data === null) && wildcardNode !== null) {
    // TODO test没有测试到这种情况
    if (node && node.data === null) {
      console.log(123, path)
    }
    node = wildcardNode;
    params[node.paramName || "_"] = wildCardParam;
    paramsFound = true;
  }

  if (!node) {
    return null;
  }

  if (paramsFound) {
    return {
      ...node.data,
      params: paramsFound ? params : undefined,
    };
  }

  // 返回handler 动态参数等
  return node.data;
}

/** 
 * 插入新的路由
 * 将path通过/分割后，依次插入radix tree
 * tree 节点分为：普通节点，动态节点，动态混合节点，泛节点，后3种用于动态匹配
 */
function insert(ctx: RadixRouterContext, path: string, data: any) {
  let isStaticRoute = true;

  const sections = path.split("/");

  let node = ctx.rootNode;

  let _unnamedPlaceholderCtr = 0;

  // 路径按/拆解，创建radix tree
  for (const section of sections) {
    let childNode: RadixNode<RadixNodeData>;

    if ((childNode = node.children.get(section))) {
      // 已存在
      node = childNode;
    } else {
      const type = getNodeType(section);

      // Create new node to represent the next part of the path
      childNode = createRadixNode({ type, parent: node });

      node.children.set(section, childNode);

      // 处理动态路由
      if (type === NODE_TYPES.PLACEHOLDER) {
        // 动态路由*
        if (section === "*") {
          // 动态参数自动命名
          childNode.paramName = `_${_unnamedPlaceholderCtr++}`;
        } else {
          const PARAMS_RE = /:\w+|[^:]+/g;
          const params = [...section.matchAll(PARAMS_RE)].map((i) => i[0]);
          // 动态路由: 命名
          // :id
          if (params.length === 1) {
            childNode.paramName = params[0].slice(1);
          // 混合动态路由 
          // :id_:subId_xx
          } else {
            childNode.type = NODE_TYPES.MIXED;
            const sectionRegexString = section.replace(
              /:(\w+)/g,
              (_, id) => `(?<${id}>\\w+)`, // 正则命名捕获组，方便后面使用
            );
            childNode.paramMatcher = new RegExp(`^${sectionRegexString}$`);
          }
        }
        node.placeholderChildNode = childNode;
        isStaticRoute = false;
      // 处理泛路由
      } else if (type === NODE_TYPES.WILDCARD) {
        node.wildcardChildNode = childNode;
        // 动态参数名称，比如 /jobs/**:id
        childNode.paramName = section.slice(3 /* "**:" */) || "_";
        isStaticRoute = false;
      }

      node = childNode;
    }
  }

  // Store whatever data was provided into the node
  // data是存放在最后一个节点的，它用于lookup时判断是否结束
  node.data = data;

  // Optimization, if a route is static and does not have any
  // variable sections, we can store it into a map for faster retrievals
  // 静态路由存储map中，它的优先级更高，匹配速度更快
  if (isStaticRoute === true) {
    ctx.staticRoutesMap[path] = node;
  }

  return node;
}

function remove(ctx: RadixRouterContext, path: string) {
  let success = false;
  const sections = path.split("/");
  let node = ctx.rootNode;

  for (const section of sections) {
    node = node.children.get(section);
    if (!node) {
      return success;
    }
  }

  if (node.data) {
    const lastSection = sections.at(-1);
    node.data = null;
    if (node.children.size === 0) {
      const parentNode = node.parent;
      parentNode.children.delete(lastSection);
      parentNode.wildcardChildNode = null;
      parentNode.placeholderChildNode = null;
    }
    success = true;
  }

  return success;
}

function createRadixNode(options: Partial<RadixNode> = {}): RadixNode {
  return {
    type: options.type || NODE_TYPES.NORMAL,
    parent: options.parent || null,
    children: new Map(),
    /** 路由数据，一般包含路由处理函数handler等 */
    data: options.data || null,
    /** 动态参数名称 */
    paramName: options.paramName || null,
    /** 动态参数匹配 */
    // paramMatcher?: string | RegExp;
    /** 泛子节点 */
    wildcardChildNode: null,
    /** 动态子节点 */
    placeholderChildNode: null,
  };
}

function getNodeType(str: string) {
  if (str.startsWith("**")) {
    return NODE_TYPES.WILDCARD;
  }
  if (str.includes(":") || str === "*") {
    return NODE_TYPES.PLACEHOLDER;
  }
  return NODE_TYPES.NORMAL;
}
