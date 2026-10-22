// 模拟 cordis 上下文对服务的访问语义。
//
// 宿主里，插件没写进 `inject` 的服务**不能**用属性访问取：
// cordis 的 Proxy trap 会抛 `cannot get property "x" without inject`。
// 只有 `ctx.get(name)`（reflect.get，免 inject）能安全地取到 undefined。
//
// 过去的本地夹具用普通对象，取未声明服务只会得到 undefined，
// 于是「本地全绿、宿主一装就挂」——这里把宿主语义搬进夹具。
export function cordisLikeContext(target, injected = []) {
  const declared = new Set(injected)
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') {
        return Reflect.get(obj, prop, receiver)
      }
      if (Reflect.has(obj, prop)) return Reflect.get(obj, prop, receiver)
      // 声明了但当前不可用：cordis 报 inactive context，这里退化为 undefined。
      if (declared.has(prop)) return undefined
      throw new Error(`cannot get property "${prop}" without inject`)
    },
  })
}
