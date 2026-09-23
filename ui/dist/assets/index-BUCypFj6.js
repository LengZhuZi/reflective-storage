(function polyfill() {
  const relList = document.createElement("link").relList;
  if (relList && relList.supports && relList.supports("modulepreload")) {
    return;
  }
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    processPreload(link);
  }
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") {
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.tagName === "LINK" && node.rel === "modulepreload")
          processPreload(node);
      }
    }
  }).observe(document, { childList: true, subtree: true });
  function getFetchOpts(link) {
    const fetchOpts = {};
    if (link.integrity) fetchOpts.integrity = link.integrity;
    if (link.referrerPolicy) fetchOpts.referrerPolicy = link.referrerPolicy;
    if (link.crossOrigin === "use-credentials")
      fetchOpts.credentials = "include";
    else if (link.crossOrigin === "anonymous") fetchOpts.credentials = "omit";
    else fetchOpts.credentials = "same-origin";
    return fetchOpts;
  }
  function processPreload(link) {
    if (link.ep)
      return;
    link.ep = true;
    const fetchOpts = getFetchOpts(link);
    fetch(link.href, fetchOpts);
  }
})();
var n, l$1, u$2, i$1, r$1, o$1, e$1, f$2, c$1, a$1, s$1, h$1, p$1, v$1, d$1 = {}, w$1 = [], _ = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i, g = Array.isArray;
function m$1(n2, l2) {
  for (var u2 in l2) n2[u2] = l2[u2];
  return n2;
}
function b(n2) {
  n2 && n2.parentNode && n2.parentNode.removeChild(n2);
}
function k$1(l2, u2, t2) {
  var i2, r2, o2, e2 = {};
  for (o2 in u2) "key" == o2 ? i2 = u2[o2] : "ref" == o2 ? r2 = u2[o2] : e2[o2] = u2[o2];
  if (arguments.length > 2 && (e2.children = arguments.length > 3 ? n.call(arguments, 2) : t2), "function" == typeof l2 && null != l2.defaultProps) for (o2 in l2.defaultProps) void 0 === e2[o2] && (e2[o2] = l2.defaultProps[o2]);
  return x(l2, e2, i2, r2, null);
}
function x(n2, t2, i2, r2, o2) {
  var e2 = { type: n2, props: t2, key: i2, ref: r2, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: void 0, __v: null == o2 ? ++u$2 : o2, __i: -1, __u: 0 };
  return null == o2 && null != l$1.vnode && l$1.vnode(e2), e2;
}
function S(n2) {
  return n2.children;
}
function C$1(n2, l2) {
  this.props = n2, this.context = l2;
}
function $(n2, l2) {
  if (null == l2) return n2.__ ? $(n2.__, n2.__i + 1) : null;
  for (var u2; l2 < n2.__k.length; l2++) if (null != (u2 = n2.__k[l2]) && null != u2.__e) return u2.__e;
  return "function" == typeof n2.type ? $(n2) : null;
}
function I(n2) {
  if (n2.__P && n2.__d) {
    var u2 = n2.__v, t2 = u2.__e, i2 = [], r2 = [], o2 = m$1({}, u2);
    o2.__v = u2.__v + 1, l$1.vnode && l$1.vnode(o2), q$1(n2.__P, o2, u2, n2.__n, n2.__P.namespaceURI, 32 & u2.__u ? [t2] : null, i2, null == t2 ? $(u2) : t2, !!(32 & u2.__u), r2), o2.__v = u2.__v, o2.__.__k[o2.__i] = o2, D$1(i2, o2, r2), u2.__e = u2.__ = null, o2.__e != t2 && P(o2);
  }
}
function P(n2) {
  if (null != (n2 = n2.__) && null != n2.__c) return n2.__e = n2.__c.base = null, n2.__k.some(function(l2) {
    if (null != l2 && null != l2.__e) return n2.__e = n2.__c.base = l2.__e;
  }), P(n2);
}
function A$1(n2) {
  (!n2.__d && (n2.__d = true) && i$1.push(n2) && !H.__r++ || r$1 != l$1.debounceRendering) && ((r$1 = l$1.debounceRendering) || o$1)(H);
}
function H() {
  try {
    for (var n2, l2 = 1; i$1.length; ) i$1.length > l2 && i$1.sort(e$1), n2 = i$1.shift(), l2 = i$1.length, I(n2);
  } finally {
    i$1.length = H.__r = 0;
  }
}
function L(n2, l2, u2, t2, i2, r2, o2, e2, f2, c2, a2) {
  var s2, h2, p2, v2, y2, _2, g2 = t2 && t2.__k || w$1, m2 = l2.length;
  for (f2 = T$1(u2, l2, g2, f2, m2), s2 = 0; s2 < m2; s2++) null != (p2 = u2.__k[s2]) && (h2 = -1 != p2.__i && g2[p2.__i] || d$1, p2.__i = s2, _2 = q$1(n2, p2, h2, i2, r2, o2, e2, f2, c2, a2), v2 = p2.__e, p2.ref && h2.ref != p2.ref && (h2.ref && J(h2.ref, null, p2), a2.push(p2.ref, p2.__c || v2, p2)), null == y2 && null != v2 && (y2 = v2), 4 & p2.__u ? (f2 = j$1(p2, f2, n2), h2.__e && (h2.__e = null)) : "function" == typeof p2.type && void 0 !== _2 ? f2 = _2 : v2 && (f2 = v2.nextSibling), p2.__u &= -7);
  return u2.__e = y2, f2;
}
function T$1(n2, l2, u2, t2, i2) {
  var r2, o2, e2, f2, c2, a2 = u2.length, s2 = a2, h2 = 0;
  for (n2.__k = new Array(i2), r2 = 0; r2 < i2; r2++) null != (o2 = l2[r2]) && "boolean" != typeof o2 && "function" != typeof o2 ? ("string" == typeof o2 || "number" == typeof o2 || "bigint" == typeof o2 || o2.constructor == String ? o2 = n2.__k[r2] = x(null, o2, null, null, null) : g(o2) ? o2 = n2.__k[r2] = x(S, { children: o2 }, null, null, null) : void 0 === o2.constructor && o2.__b > 0 ? o2 = n2.__k[r2] = x(o2.type, o2.props, o2.key, o2.ref ? o2.ref : null, o2.__v) : n2.__k[r2] = o2, f2 = r2 + h2, o2.__ = n2, o2.__b = n2.__b + 1, e2 = null, -1 != (c2 = o2.__i = O(o2, u2, f2, s2)) && (s2--, (e2 = u2[c2]) && (e2.__u |= 2)), null == e2 || null == e2.__v ? (-1 == c2 && (i2 > a2 ? h2-- : i2 < a2 && h2++), "function" != typeof o2.type && (o2.__u |= 4)) : c2 != f2 && (c2 == f2 - 1 ? h2-- : c2 == f2 + 1 ? h2++ : (c2 > f2 ? h2-- : h2++, o2.__u |= 4))) : n2.__k[r2] = null;
  if (s2) for (r2 = 0; r2 < a2; r2++) null != (e2 = u2[r2]) && 0 == (2 & e2.__u) && (e2.__e == t2 && (t2 = $(e2)), K(e2, e2));
  return t2;
}
function j$1(n2, l2, u2) {
  var t2, i2;
  if ("function" == typeof n2.type) {
    for (t2 = n2.__k, i2 = 0; t2 && i2 < t2.length; i2++) t2[i2] && (t2[i2].__ = n2, l2 = j$1(t2[i2], l2, u2));
    return l2;
  }
  n2.__e != l2 && (l2 && n2.type && !l2.parentNode && (l2 = $(n2)), l2 = u2.insertBefore(n2.__e, l2 || null));
  do {
    l2 = l2 && l2.nextSibling;
  } while (null != l2 && 8 == l2.nodeType);
  return l2;
}
function O(n2, l2, u2, t2) {
  var i2, r2, o2, e2 = n2.key, f2 = n2.type, c2 = l2[u2], a2 = null != c2 && 0 == (2 & c2.__u);
  if (null === c2 && null == e2 || a2 && e2 == c2.key && f2 == c2.type) return u2;
  if (t2 > (a2 ? 1 : 0)) {
    for (i2 = u2 - 1, r2 = u2 + 1; i2 >= 0 || r2 < l2.length; ) if (null != (c2 = l2[o2 = i2 >= 0 ? i2-- : r2++]) && 0 == (2 & c2.__u) && e2 == c2.key && f2 == c2.type) return o2;
  }
  return -1;
}
function z$1(n2, l2, u2) {
  "-" == l2[0] ? n2.setProperty(l2, null == u2 ? "" : u2) : n2[l2] = null == u2 ? "" : "number" != typeof u2 || _.test(l2) ? u2 : u2 + "px";
}
function N(n2, l2, u2, t2, i2) {
  var r2, o2;
  n: if ("style" == l2) if ("string" == typeof u2) n2.style.cssText = u2;
  else {
    if ("string" == typeof t2 && (n2.style.cssText = t2 = ""), t2) for (l2 in t2) u2 && l2 in u2 || z$1(n2.style, l2, "");
    if (u2) for (l2 in u2) t2 && u2[l2] == t2[l2] || z$1(n2.style, l2, u2[l2]);
  }
  else if ("o" == l2[0] && "n" == l2[1]) r2 = l2 != (l2 = l2.replace(s$1, "$1")), o2 = l2.toLowerCase(), l2 = o2 in n2 || "onFocusOut" == l2 || "onFocusIn" == l2 ? o2.slice(2) : l2.slice(2), n2.l || (n2.l = {}), n2.l[l2 + r2] = u2, u2 ? t2 ? u2[a$1] = t2[a$1] : (u2[a$1] = h$1, n2.addEventListener(l2, r2 ? v$1 : p$1, r2)) : n2.removeEventListener(l2, r2 ? v$1 : p$1, r2);
  else {
    if ("http://www.w3.org/2000/svg" == i2) l2 = l2.replace(/xlink(H|:h)/, "h").replace(/sName$/, "s");
    else if ("width" != l2 && "height" != l2 && "href" != l2 && "list" != l2 && "form" != l2 && "tabIndex" != l2 && "download" != l2 && "rowSpan" != l2 && "colSpan" != l2 && "role" != l2 && "popover" != l2 && l2 in n2) try {
      n2[l2] = null == u2 ? "" : u2;
      break n;
    } catch (n3) {
    }
    "function" == typeof u2 || (null == u2 || false === u2 && "-" != l2[4] ? n2.removeAttribute(l2) : n2.setAttribute(l2, "popover" == l2 && 1 == u2 ? "" : u2));
  }
}
function V(n2) {
  return function(u2) {
    if (this.l) {
      var t2 = this.l[u2.type + n2];
      if (null == u2[c$1]) u2[c$1] = h$1++;
      else if (u2[c$1] < t2[a$1]) return;
      return t2(l$1.event ? l$1.event(u2) : u2);
    }
  };
}
function q$1(n2, u2, t2, i2, r2, o2, e2, f2, c2, a2) {
  var s2, h2, p2, v2, y2, d2, _2, k2, x2, M, I2, P2, A2, H2, T2, j2, F = u2.type;
  if (void 0 !== u2.constructor) return null;
  128 & t2.__u && (c2 = !!(32 & t2.__u), o2 = [f2 = u2.__e = t2.__e]), (s2 = l$1.__b) && s2(u2);
  n: if ("function" == typeof F) {
    h2 = e2.length;
    try {
      if (x2 = u2.props, M = F.prototype && F.prototype.render, I2 = (s2 = F.contextType) && i2[s2.__c], P2 = s2 ? I2 ? I2.props.value : s2.__ : i2, t2.__c ? k2 = (p2 = u2.__c = t2.__c).__ = p2.__E : (M ? u2.__c = p2 = new F(x2, P2) : (u2.__c = p2 = new C$1(x2, P2), p2.constructor = F, p2.render = Q), I2 && I2.sub(p2), p2.state || (p2.state = {}), p2.__n = i2, v2 = p2.__d = true, p2.__h = [], p2._sb = []), M && null == p2.__s && (p2.__s = p2.state), M && null != F.getDerivedStateFromProps && (p2.__s == p2.state && (p2.__s = m$1({}, p2.__s)), m$1(p2.__s, F.getDerivedStateFromProps(x2, p2.__s))), y2 = p2.props, d2 = p2.state, p2.__v = u2, v2) M && null == F.getDerivedStateFromProps && null != p2.componentWillMount && p2.componentWillMount(), M && null != p2.componentDidMount && p2.__h.push(p2.componentDidMount);
      else {
        if (M && null == F.getDerivedStateFromProps && x2 !== y2 && null != p2.componentWillReceiveProps && p2.componentWillReceiveProps(x2, P2), u2.__v == t2.__v || !p2.__e && null != p2.shouldComponentUpdate && false === p2.shouldComponentUpdate(x2, p2.__s, P2)) {
          u2.__v != t2.__v && (p2.props = x2, p2.state = p2.__s, p2.__d = false), u2.__e = t2.__e, u2.__k = t2.__k, u2.__k.some(function(n3) {
            n3 && (n3.__ = u2);
          }), w$1.push.apply(p2.__h, p2._sb), p2._sb = [], p2.__h.length && e2.push(p2), f2 = $(t2);
          break n;
        }
        null != p2.componentWillUpdate && p2.componentWillUpdate(x2, p2.__s, P2), M && null != p2.componentDidUpdate && p2.__h.push(function() {
          p2.componentDidUpdate(y2, d2, _2);
        });
      }
      if (p2.context = P2, p2.props = x2, p2.__P = n2, p2.__e = false, A2 = l$1.__r, H2 = 0, M) p2.state = p2.__s, p2.__d = false, A2 && A2(u2), s2 = p2.render(p2.props, p2.state, p2.context), w$1.push.apply(p2.__h, p2._sb), p2._sb = [];
      else do {
        p2.__d = false, A2 && A2(u2), s2 = p2.render(p2.props, p2.state, p2.context), p2.state = p2.__s;
      } while (p2.__d && ++H2 < 25);
      p2.state = p2.__s, null != p2.getChildContext && (i2 = m$1(m$1({}, i2), p2.getChildContext())), M && !v2 && null != p2.getSnapshotBeforeUpdate && (_2 = p2.getSnapshotBeforeUpdate(y2, d2)), T2 = null != s2 && s2.type === S && null == s2.key ? E(s2.props.children) : s2, f2 = L(n2, g(T2) ? T2 : [T2], u2, t2, i2, r2, o2, e2, f2, c2, a2), p2.base = u2.__e, u2.__u &= -161, p2.__h.length && e2.push(p2), k2 && (p2.__E = p2.__ = null);
    } catch (n3) {
      if (e2.length = h2, u2.__v = null, c2 || null != o2) {
        if (n3.then) {
          for (u2.__u |= c2 ? 160 : 128; f2 && 8 == f2.nodeType && f2.nextSibling; ) f2 = f2.nextSibling;
          null != o2 && (o2[o2.indexOf(f2)] = null), u2.__e = f2;
        } else if (null != o2) for (j2 = o2.length; j2--; ) b(o2[j2]);
      } else u2.__e = t2.__e;
      null == u2.__k && (u2.__k = t2.__k || []), n3.then || B$1(u2), l$1.__e(n3, u2, t2);
    }
  } else null == o2 && u2.__v == t2.__v ? (u2.__k = t2.__k, u2.__e = t2.__e) : f2 = u2.__e = G(t2.__e, u2, t2, i2, r2, o2, e2, c2, a2);
  return (s2 = l$1.diffed) && s2(u2), 128 & u2.__u ? void 0 : f2;
}
function B$1(n2) {
  n2 && (n2.__c && (n2.__c.__e = true), n2.__k && n2.__k.some(B$1));
}
function D$1(n2, u2, t2) {
  for (var i2 = 0; i2 < t2.length; i2++) J(t2[i2], t2[++i2], t2[++i2]);
  l$1.__c && l$1.__c(u2, n2), n2.some(function(u3) {
    try {
      n2 = u3.__h, u3.__h = [], n2.some(function(n3) {
        n3.call(u3);
      });
    } catch (n3) {
      l$1.__e(n3, u3.__v);
    }
  });
}
function E(n2) {
  return "object" != typeof n2 || null == n2 || n2.__b > 0 ? n2 : g(n2) ? n2.map(E) : void 0 !== n2.constructor ? null : m$1({}, n2);
}
function G(u2, t2, i2, r2, o2, e2, f2, c2, a2) {
  var s2, h2, p2, v2, y2, w2, _2, m2 = i2.props || d$1, k2 = t2.props, x2 = t2.type;
  if ("svg" == x2 ? o2 = "http://www.w3.org/2000/svg" : "math" == x2 ? o2 = "http://www.w3.org/1998/Math/MathML" : o2 || (o2 = "http://www.w3.org/1999/xhtml"), null != e2) {
    for (s2 = 0; s2 < e2.length; s2++) if ((y2 = e2[s2]) && "setAttribute" in y2 == !!x2 && (x2 ? y2.localName == x2 : 3 == y2.nodeType)) {
      u2 = y2, e2[s2] = null;
      break;
    }
  }
  if (null == u2) {
    if (null == x2) return document.createTextNode(k2);
    u2 = document.createElementNS(o2, x2, k2.is && k2), c2 && (l$1.__m && l$1.__m(t2, e2), c2 = false), e2 = null;
  }
  if (null == x2) m2 === k2 || c2 && u2.data == k2 || (u2.data = k2);
  else {
    if (e2 = "textarea" == x2 && null != k2.defaultValue ? null : e2 && n.call(u2.childNodes), !c2 && null != e2) for (m2 = {}, s2 = 0; s2 < u2.attributes.length; s2++) m2[(y2 = u2.attributes[s2]).name] = y2.value;
    for (s2 in m2) y2 = m2[s2], "dangerouslySetInnerHTML" == s2 ? p2 = y2 : "children" == s2 || s2 in k2 || "value" == s2 && "defaultValue" in k2 || "checked" == s2 && "defaultChecked" in k2 || N(u2, s2, null, y2, o2);
    for (s2 in k2) y2 = k2[s2], "children" == s2 ? v2 = y2 : "dangerouslySetInnerHTML" == s2 ? h2 = y2 : "value" == s2 ? w2 = y2 : "checked" == s2 ? _2 = y2 : c2 && "function" != typeof y2 || m2[s2] === y2 || N(u2, s2, y2, m2[s2], o2);
    if (h2) c2 || p2 && (h2.__html == p2.__html || h2.__html == u2.innerHTML) || (u2.innerHTML = h2.__html), t2.__k = [];
    else if (p2 && (u2.innerHTML = ""), L("template" == t2.type ? u2.content : u2, g(v2) ? v2 : [v2], t2, i2, r2, "foreignObject" == x2 ? "http://www.w3.org/1999/xhtml" : o2, e2, f2, e2 ? e2[0] : i2.__k && $(i2, 0), c2, a2), null != e2) for (s2 = e2.length; s2--; ) b(e2[s2]);
    c2 && "textarea" != x2 || (s2 = "value", "progress" == x2 && null == w2 ? u2.removeAttribute("value") : null != w2 && (w2 !== u2[s2] || "progress" == x2 && !w2 || "option" == x2 && w2 != m2[s2]) && N(u2, s2, w2, m2[s2], o2), s2 = "checked", null != _2 && _2 != u2[s2] && N(u2, s2, _2, m2[s2], o2));
  }
  return u2;
}
function J(n2, u2, t2) {
  try {
    if ("function" == typeof n2) {
      var i2 = "function" == typeof n2.__u;
      i2 && n2.__u(), i2 && null == u2 || (n2.__u = n2(u2));
    } else n2.current = u2;
  } catch (n3) {
    l$1.__e(n3, t2);
  }
}
function K(n2, u2, t2) {
  var i2, r2;
  if (l$1.unmount && l$1.unmount(n2), (i2 = n2.ref) && (i2.current && i2.current != n2.__e || J(i2, null, u2)), null != (i2 = n2.__c)) {
    if (i2.componentWillUnmount) try {
      i2.componentWillUnmount();
    } catch (n3) {
      l$1.__e(n3, u2);
    }
    i2.base = i2.__P = i2.__n = null;
  }
  if (i2 = n2.__k) for (r2 = 0; r2 < i2.length; r2++) i2[r2] && K(i2[r2], u2, t2 || "function" != typeof n2.type);
  t2 || b(n2.__e), n2.__c = n2.__ = n2.__e = void 0;
}
function Q(n2, l2, u2) {
  return this.constructor(n2, u2);
}
function R(u2, t2, i2) {
  var r2, o2, e2, f2;
  t2 == document && (t2 = document.documentElement), l$1.__ && l$1.__(u2, t2), o2 = (r2 = false) ? null : t2.__k, e2 = [], f2 = [], q$1(t2, u2 = t2.__k = k$1(S, null, [u2]), o2 || d$1, d$1, t2.namespaceURI, o2 ? null : t2.firstChild ? n.call(t2.childNodes) : null, e2, o2 ? o2.__e : t2.firstChild, r2, f2), D$1(e2, u2, f2), u2.props.children = null;
}
n = w$1.slice, l$1 = { __e: function(n2, l2, u2, t2) {
  for (var i2, r2, o2; l2 = l2.__; ) if ((i2 = l2.__c) && !i2.__) try {
    if ((r2 = i2.constructor) && null != r2.getDerivedStateFromError && (i2.setState(r2.getDerivedStateFromError(n2)), o2 = i2.__d), null != i2.componentDidCatch && (i2.componentDidCatch(n2, t2 || {}), o2 = i2.__d), o2) return i2.__E = i2;
  } catch (l3) {
    n2 = l3;
  }
  throw n2;
} }, u$2 = 0, C$1.prototype.setState = function(n2, l2) {
  var u2;
  u2 = null != this.__s && this.__s != this.state ? this.__s : this.__s = m$1({}, this.state), "function" == typeof n2 && (n2 = n2(m$1({}, u2), this.props)), n2 && m$1(u2, n2), null != n2 && this.__v && (l2 && this._sb.push(l2), A$1(this));
}, C$1.prototype.forceUpdate = function(n2) {
  this.__v && (this.__e = true, n2 && this.__h.push(n2), A$1(this));
}, C$1.prototype.render = S, i$1 = [], o$1 = "function" == typeof Promise ? Promise.prototype.then.bind(Promise.resolve()) : setTimeout, e$1 = function(n2, l2) {
  return n2.__v.__b - l2.__v.__b;
}, H.__r = 0, f$2 = Math.random().toString(8), c$1 = "__d" + f$2, a$1 = "__a" + f$2, s$1 = /(PointerCapture)$|Capture$/i, h$1 = 0, p$1 = V(false), v$1 = V(true);
var f$1 = 0;
function u$1(e2, t2, n2, o2, i2, u2) {
  t2 || (t2 = {});
  var a2, c2, p2 = t2;
  if ("ref" in p2) for (c2 in p2 = {}, t2) "ref" == c2 ? a2 = t2[c2] : p2[c2] = t2[c2];
  var l2 = { type: e2, props: p2, key: n2, ref: a2, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: void 0, __v: --f$1, __i: -1, __u: 0, __source: i2, __self: u2 };
  if ("function" == typeof e2 && (a2 = e2.defaultProps)) for (c2 in a2) void 0 === p2[c2] && (p2[c2] = a2[c2]);
  return l$1.vnode && l$1.vnode(l2), l2;
}
var t, r, u, i, o = 0, f = [], c = l$1, e = c.__b, a = c.__r, v = c.diffed, l = c.__c, m = c.unmount, p = c.__;
function s(n2, t2) {
  c.__h && c.__h(r, n2, o || t2), o = 0;
  var u2 = r.__H || (r.__H = { __: [], __h: [] });
  return n2 >= u2.__.length && u2.__.push({}), u2.__[n2];
}
function d(n2) {
  return o = 1, y(D, n2);
}
function y(n2, u2, i2) {
  var o2 = s(t++, 2);
  if (o2.t = n2, !o2.__c && (o2.__ = [D(void 0, u2), function(n3) {
    var t2 = o2.__N ? o2.__N[0] : o2.__[0], r2 = o2.t(t2, n3);
    t2 !== r2 && (o2.__N = [r2, o2.__[1]], o2.__c.setState({}));
  }], o2.__c = r, !r.__f)) {
    var f2 = function(n3, t2, r2) {
      if (!o2.__c.__H) return true;
      var u3 = false, i3 = o2.__c.props !== n3;
      if (o2.__c.__H.__.some(function(n4) {
        if (n4.__N) {
          u3 = true;
          var t3 = n4.__[0];
          n4.__ = n4.__N, n4.__N = void 0, t3 !== n4.__[0] && (i3 = true);
        }
      }), c2) {
        var f3 = c2.call(this, n3, t2, r2);
        return u3 ? f3 || i3 : f3;
      }
      return !u3 || i3;
    };
    r.__f = true;
    var c2 = r.shouldComponentUpdate, e2 = r.componentWillUpdate;
    r.componentWillUpdate = function(n3, t2, r2) {
      if (this.__e) {
        var u3 = c2;
        c2 = void 0, f2(n3, t2, r2), c2 = u3;
      }
      e2 && e2.call(this, n3, t2, r2);
    }, r.shouldComponentUpdate = f2;
  }
  return o2.__N || o2.__;
}
function h(n2, u2) {
  var i2 = s(t++, 3);
  !c.__s && C(i2.__H, u2) && (i2.__ = n2, i2.u = u2, r.__H.__h.push(i2));
}
function A(n2) {
  return o = 5, T(function() {
    return { current: n2 };
  }, []);
}
function T(n2, r2) {
  var u2 = s(t++, 7);
  return C(u2.__H, r2) && (u2.__ = n2(), u2.__H = r2, u2.__h = n2), u2.__;
}
function q(n2, t2) {
  return o = 8, T(function() {
    return n2;
  }, t2);
}
function j() {
  for (var n2; n2 = f.shift(); ) {
    var t2 = n2.__H;
    if (n2.__P && t2) try {
      t2.__h.some(z), t2.__h.some(B), t2.__h = [];
    } catch (r2) {
      t2.__h = [], c.__e(r2, n2.__v);
    }
  }
}
c.__b = function(n2) {
  r = null, e && e(n2);
}, c.__ = function(n2, t2) {
  n2 && t2.__k && t2.__k.__m && (n2.__m = t2.__k.__m), p && p(n2, t2);
}, c.__r = function(n2) {
  a && a(n2), t = 0;
  var i2 = (r = n2.__c).__H;
  i2 && (u === r ? (i2.__h = [], r.__h = [], i2.__.some(function(n3) {
    n3.__N && (n3.__ = n3.__N), n3.u = n3.__N = void 0;
  })) : (i2.__h.some(z), i2.__h.some(B), i2.__h = [], t = 0)), u = r;
}, c.diffed = function(n2) {
  v && v(n2);
  var t2 = n2.__c;
  t2 && t2.__H && (t2.__H.__h.length && (1 !== f.push(t2) && i === c.requestAnimationFrame || ((i = c.requestAnimationFrame) || w)(j)), t2.__H.__.some(function(n3) {
    n3.u && (n3.__H = n3.u, n3.u = void 0);
  })), u = r = null;
}, c.__c = function(n2, t2) {
  t2.some(function(n3) {
    try {
      n3.__h.some(z), n3.__h = n3.__h.filter(function(n4) {
        return !n4.__ || B(n4);
      });
    } catch (r2) {
      t2.some(function(n4) {
        n4.__h && (n4.__h = []);
      }), t2 = [], c.__e(r2, n3.__v);
    }
  }), l && l(n2, t2);
}, c.unmount = function(n2) {
  m && m(n2);
  var t2, r2 = n2.__c;
  r2 && r2.__H && (r2.__H.__.some(function(n3) {
    try {
      z(n3);
    } catch (n4) {
      t2 = n4;
    }
  }), r2.__H = void 0, t2 && c.__e(t2, r2.__v));
};
var k = "function" == typeof requestAnimationFrame;
function w(n2) {
  var t2, r2 = function() {
    clearTimeout(u2), k && cancelAnimationFrame(t2), setTimeout(n2);
  }, u2 = setTimeout(r2, 35);
  k && (t2 = requestAnimationFrame(r2));
}
function z(n2) {
  var t2 = r, u2 = n2.__c;
  "function" == typeof u2 && (n2.__c = void 0, u2()), r = t2;
}
function B(n2) {
  var t2 = r;
  n2.__c = n2.__(), r = t2;
}
function C(n2, t2) {
  return !n2 || n2.length !== t2.length || t2.some(function(t3, r2) {
    return t3 !== n2[r2];
  });
}
function D(n2, t2) {
  return "function" == typeof t2 ? t2(n2) : t2;
}
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
async function req(path, init) {
  const res = await fetch(path, init);
  if (res.ok) return await res.json();
  let msg = `${res.status}`;
  try {
    const body = await res.json();
    if (body.error) msg = body.error;
  } catch {
  }
  throw new ApiError(msg, res.status);
}
const MUT = { headers: { "x-csrf": "1" } };
const post = (path, body) => req(path, { ...MUT, method: "POST", headers: { ...MUT.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
const api = {
  session: () => req("/api/session"),
  overview: (scope) => req(`/api/overview?scope=${scope}`),
  memories: (scope, q2 = {}) => {
    const p2 = new URLSearchParams({ scope });
    if (q2.state) p2.set("state", q2.state);
    if (q2.topic) p2.set("topic", q2.topic);
    return req(`/api/memories?${p2}`);
  },
  detail: (scope, id) => req(`/api/memory-detail?scope=${scope}&id=${encodeURIComponent(id)}`),
  graph: (scope) => req(`/api/graph?scope=${scope}`),
  dupes: (scope) => req(`/api/dupes?scope=${scope}`),
  remove: (scope, id) => req(`/api/memory/${encodeURIComponent(id)}?scope=${scope}`, { ...MUT, method: "DELETE" }),
  merge: (keep, drop) => post("/api/merge", { keep, drop }),
  resolveReview: (id, resolution) => post(`/api/review/${encodeURIComponent(id)}`, { resolution }),
  config: () => req("/api/config"),
  saveConfig: (patch) => post("/api/config", patch),
  /** 账号密码走表单：服务端 readBody 后按 URLSearchParams 解析。 */
  account: (form) => fetch("/api/account", {
    ...MUT,
    method: "POST",
    headers: { ...MUT.headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form)
  }).then(async (r2) => {
    if (r2.ok) return await r2.json();
    throw new ApiError((await r2.json()).error ?? `${r2.status}`, r2.status);
  })
};
const shortId = (id) => id.slice(0, 8);
function ago(ms, now = Date.now()) {
  if (!ms) return "-";
  const s2 = Math.max(0, Math.round((now - ms) / 1e3));
  if (s2 < 60) return `${s2} 秒前`;
  const m2 = Math.round(s2 / 60);
  if (m2 < 60) return `${m2} 分钟前`;
  const h2 = Math.round(m2 / 60);
  if (h2 < 24) return `${h2} 小时前`;
  const d2 = Math.round(h2 / 24);
  if (d2 < 30) return `${d2} 天前`;
  const mo = Math.round(d2 / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.round(mo / 12)} 年前`;
}
const stamp = (ms) => ms ? new Date(Number(ms)).toLocaleString() : "-";
const pct = (n2) => n2 == null ? "-" : `${(n2 * 100).toFixed(0)}%`;
const fixed = (n2, d2 = 2) => n2.toFixed(d2);
const STATE_TONE = {
  active: "accent",
  cold: "warn",
  archived: "",
  superseded: "bad"
};
const STATE_LABEL = {
  active: "active",
  cold: "cold",
  archived: "archived",
  superseded: "superseded"
};
const TYPE_LABEL = {
  fact: "事实",
  preference: "偏好",
  procedure: "流程",
  relation: "关系",
  event: "事件",
  emotion: "情绪"
};
const SCOPE_LABEL = {
  project: "项目",
  global: "全局",
  session: "会话"
};
const KIND_LABEL = {
  supersedes: "取代",
  contradicts: "冲突",
  extends: "延伸",
  related: "相关",
  topic: "同主题",
  path: "同路径",
  similar: "相似"
};
function humanTrace(gate, action) {
  const key = `${gate} ${action}`;
  const map = {
    "J1+J2+J3 keep": "记住了",
    "J1+J2+J3 skip": "没记",
    "dedup duplicate": "已存在，没重复写",
    "J3 superseded": "标为被取代",
    "J5 keep": "判定需要查",
    "J5 skip": "判定不用查",
    "J7 keep": "重排后留下候选",
    "J7 skip": "重排后没有可用候选",
    "J8 inject": "注入进对话",
    "J8 skip": "不注入",
    "J9 promote": "巩固：提权",
    "J12 archive": "归档",
    "J12 delete": "删除",
    "J13 resurrect": "复活",
    "J14a block": "边界判断挡下",
    "J15 cite": "确认用上了",
    "J16 remind": "主动提醒",
    "J14c explain": "一句人话"
  };
  return map[key] ?? `${gate} ${action}`;
}
const PATHS = {
  overview: "M2.5 9.5 8 3l5.5 6.5M4 8.5V13h8V8.5",
  graph: "M8 2.6a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8ZM3.4 9.6a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4Zm9.2 0a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4ZM6.9 5.9 4.4 9.3m4.7-3.4 2.5 3.4M5.1 11.3h5.8",
  list: "M3 4.5h10M3 8h10M3 11.5h6",
  review: "M8 2.8 13.5 12H2.5L8 2.8Zm0 3.4v2.6m0 1.6v.1",
  stack: "M8 2.8 13.5 6 8 9.2 2.5 6 8 2.8Zm5.5 5.4L8 11.4 2.5 8.2m11 2.9L8 14.4 2.5 11.1",
  settings: "M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6Zm5 .6-1.3-.3a3.9 3.9 0 0 0-.4-.9l.7-1.1-1.5-1.5-1.1.7a3.9 3.9 0 0 0-.9-.4L8.2 2h-2l-.3 1.3a3.9 3.9 0 0 0-.9.4L3.9 3 2.4 4.5l.7 1.1a3.9 3.9 0 0 0-.4.9L1.4 6.8v2l1.3.3c.1.3.2.6.4.9l-.7 1.1L3.9 12.6l1.1-.7c.3.2.6.3.9.4L6.2 14h2l.3-1.3c.3-.1.6-.2.9-.4l1.1.7 1.5-1.5-.7-1.1c.2-.3.3-.6.4-.9l1.3-.3v-2Z",
  search: "M7.2 3a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4Zm3.1 7.3L13 13",
  copy: "M5.5 5.5V3.2h7.3v7.3h-2.3M3.2 5.5h7.3v7.3H3.2z",
  trash: "M3 4.5h10M6.3 4.5V3.2h3.4v1.3M4.5 4.5l.6 8.3h5.8l.6-8.3M6.6 6.8v4M9.4 6.8v4",
  close: "M4 4l8 8M12 4l-8 8",
  refresh: "M13 8a5 5 0 1 1-1.6-3.7M13 2.6V5.4h-2.8",
  chevron: "M6.2 3.5 10.5 8l-4.3 4.5",
  check: "M3.2 8.4 6.4 11.6 12.8 4.8",
  sun: "M8 5.4A2.6 2.6 0 1 0 8 10.6 2.6 2.6 0 0 0 8 5.4ZM8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3 3.6 12.4",
  moon: "M12.6 9.6A5.2 5.2 0 0 1 6.4 3.4a5.2 5.2 0 1 0 6.2 6.2Z"
};
function Icon({ name, size = 16 }) {
  return /* @__PURE__ */ u$1("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", children: /* @__PURE__ */ u$1("path", { d: PATHS[name] ?? PATHS.overview }) });
}
function Chip({ tone = "", children, title }) {
  return /* @__PURE__ */ u$1("span", { class: `chip ${tone}`, title, children });
}
function StateChip({ state }) {
  return /* @__PURE__ */ u$1(Chip, { tone: STATE_TONE[state] ?? "", children: STATE_LABEL[state] ?? state });
}
function TypeChip({ type }) {
  return /* @__PURE__ */ u$1(Chip, { title: type, children: TYPE_LABEL[type] ?? type });
}
function Button({
  variant = "",
  size = "",
  icon,
  children,
  ...rest
}) {
  return /* @__PURE__ */ u$1("button", { type: "button", class: `btn ${variant} ${size}`, ...rest, children: [
    icon ? /* @__PURE__ */ u$1(Icon, { name: icon, size: 14 }) : null,
    children
  ] });
}
function KeyHint({ keys }) {
  return /* @__PURE__ */ u$1("span", { class: "nowrap", children: keys.map((k2, i2) => /* @__PURE__ */ u$1("span", { children: [
    i2 > 0 ? " " : "",
    /* @__PURE__ */ u$1("kbd", { children: k2 })
  ] }, k2)) });
}
function SearchInput({ value, onInput, placeholder, autofocus, inputRef }) {
  const ref = A(null);
  h(() => {
    if (autofocus) ref.current?.focus();
  }, [autofocus]);
  return /* @__PURE__ */ u$1("span", { class: "search-wrap", children: [
    /* @__PURE__ */ u$1(Icon, { name: "search", size: 14 }),
    /* @__PURE__ */ u$1(
      "input",
      {
        ref: (el) => {
          ref.current = el;
          inputRef?.(el);
        },
        class: "input search",
        type: "search",
        value,
        placeholder: placeholder ?? "搜索内容",
        onInput: (e2) => onInput(e2.currentTarget.value)
      }
    )
  ] });
}
function Field({ label, hint, children }) {
  return /* @__PURE__ */ u$1("div", { class: "field", children: [
    /* @__PURE__ */ u$1("label", { children: label }),
    children,
    hint ? /* @__PURE__ */ u$1("span", { class: "hint", children: hint }) : null
  ] });
}
function Metric({ k: k2, v: v2, h: h2, text }) {
  return /* @__PURE__ */ u$1("div", { class: "metric", children: [
    /* @__PURE__ */ u$1("div", { class: "k", children: k2 }),
    /* @__PURE__ */ u$1("div", { class: `v ${text ? "text" : ""}`, children: v2 }),
    h2 ? /* @__PURE__ */ u$1("div", { class: "h", children: h2 }) : null
  ] });
}
function Panel({ title, actions, children, flush, id }) {
  return /* @__PURE__ */ u$1("section", { class: "panel", id, children: [
    title || actions ? /* @__PURE__ */ u$1("header", { class: "panel-head", children: [
      title ? /* @__PURE__ */ u$1("h2", { children: title }) : null,
      /* @__PURE__ */ u$1("span", { class: "spacer" }),
      actions
    ] }) : null,
    /* @__PURE__ */ u$1("div", { class: `panel-body ${flush ? "flush" : ""}`, children })
  ] });
}
function EmptyState({ title, hint, action }) {
  return /* @__PURE__ */ u$1("div", { class: "empty", children: [
    /* @__PURE__ */ u$1("h3", { children: title }),
    hint ? /* @__PURE__ */ u$1("p", { children: hint }) : null,
    action
  ] });
}
function Skeleton({ rows = 4 }) {
  return /* @__PURE__ */ u$1("div", { style: { display: "grid", gap: "6px", padding: "12px 14px" }, children: Array.from({ length: rows }, (_2, i2) => /* @__PURE__ */ u$1("div", { class: "skeleton" }, i2)) });
}
function ErrorNote({ error, onRetry }) {
  return /* @__PURE__ */ u$1("div", { class: "empty", children: [
    /* @__PURE__ */ u$1("h3", { children: "读不到数据" }),
    /* @__PURE__ */ u$1("p", { class: "mono", children: error.message }),
    onRetry ? /* @__PURE__ */ u$1(Button, { icon: "refresh", onClick: onRetry, children: "重试" }) : null
  ] });
}
function Timeline({ items }) {
  if (items.length === 0) return /* @__PURE__ */ u$1("p", { class: "dim", children: "这条没有判断轨迹（可能是手工入库的）。" });
  return /* @__PURE__ */ u$1("div", { class: "timeline", children: items.map((t2, i2) => /* @__PURE__ */ u$1("div", { class: "timeline-item", children: [
    /* @__PURE__ */ u$1("div", { class: "gate", children: [
      t2.gate,
      " · ",
      t2.action
    ] }),
    /* @__PURE__ */ u$1("div", { class: "what", children: [
      t2.userVisible ? /* @__PURE__ */ u$1("div", { children: t2.userVisible }) : null,
      t2.reason ? /* @__PURE__ */ u$1("div", { class: "dim", children: t2.reason }) : null,
      t2.status && t2.status !== "ok" ? /* @__PURE__ */ u$1("div", { children: /* @__PURE__ */ u$1(Chip, { tone: "warn", children: [
        "判断降级：",
        t2.status
      ] }) }) : null
    ] })
  ] }, `${t2.gate}-${t2.action}-${i2}`)) });
}
function Dialog({ title, children, onClose, actions }) {
  const ref = A(null);
  h(() => {
    const onKey = (e2) => {
      if (e2.key === "Escape") {
        e2.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    ref.current?.querySelector("button,input")?.focus();
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return /* @__PURE__ */ u$1("div", { class: "overlay", role: "dialog", "aria-modal": "true", "aria-label": title, onClick: (e2) => e2.target === e2.currentTarget && onClose(), children: /* @__PURE__ */ u$1("div", { class: "dialog", ref, children: [
    /* @__PURE__ */ u$1("div", { class: "dialog-head", children: title }),
    /* @__PURE__ */ u$1("div", { class: "dialog-body", children }),
    /* @__PURE__ */ u$1("div", { class: "dialog-actions", children: actions })
  ] }) });
}
let seq = 0;
const toasts = [];
const listeners = /* @__PURE__ */ new Set();
const emit = () => listeners.forEach((l2) => l2());
function toast(text, tone = "ok") {
  const t2 = { id: ++seq, text, tone };
  toasts.push(t2);
  emit();
  setTimeout(() => {
    const i2 = toasts.findIndex((x2) => x2.id === t2.id);
    if (i2 >= 0) {
      toasts.splice(i2, 1);
      emit();
    }
  }, tone === "bad" ? 6e3 : 3200);
}
function ToastHost() {
  const [, force] = d(0);
  h(() => {
    const l2 = () => force((n2) => n2 + 1);
    listeners.add(l2);
    return () => void listeners.delete(l2);
  }, []);
  return /* @__PURE__ */ u$1("div", { class: "toasts", role: "status", "aria-live": "polite", children: toasts.map((t2) => /* @__PURE__ */ u$1("div", { class: `toast ${t2.tone === "bad" ? "bad" : ""}`, children: t2.text }, t2.id)) });
}
function useAsync(fn, deps) {
  const [data, setData] = d(null);
  const [error, setError] = d(null);
  const [loading, setLoading] = d(true);
  const [tick, setTick] = d(0);
  const reload = q(() => setTick((n2) => n2 + 1), []);
  h(() => {
    let alive = true;
    setLoading(true);
    fn().then((d2) => {
      if (!alive) return;
      setData(d2);
      setError(null);
    }).catch((e2) => alive && setError(e2)).finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [...deps, tick]);
  return { data, error, loading, reload };
}
function TimeCell({ at }) {
  return /* @__PURE__ */ u$1("span", { class: "mono faint", title: stamp(at), children: ago(at) });
}
const EDGE_STYLE = {
  supersedes: { dash: "5 3", tone: "var(--bad)", label: "取代" },
  contradicts: { dash: "5 3", tone: "var(--warn)", label: "冲突" },
  extends: { dash: "1 3", tone: "var(--edge)", label: "延伸" },
  related: { dash: "1 3", tone: "var(--edge)", label: "相关" },
  topic: { tone: "var(--edge)", label: "同主题" },
  path: { dash: "2 4", tone: "var(--edge)", label: "同路径" },
  similar: { tone: "var(--edge-dim)", label: "相似" }
};
const RAIL_EDGE_ORDER = ["supersedes", "contradicts", "topic", "path", "similar", "related", "extends"];
function clusterAngle(key, keys) {
  const i2 = Math.max(0, keys.indexOf(key ?? ""));
  return i2 / Math.max(1, keys.length) * Math.PI * 2;
}
function hashJitter(id) {
  let h2 = 0;
  for (let i2 = 0; i2 < id.length; i2++) h2 = (h2 * 31 + id.charCodeAt(i2)) % 1e3;
  return (h2 / 1e3 - 0.5) * 14;
}
function layoutGraph(data, focusId, visible) {
  const pos = /* @__PURE__ */ new Map();
  const neighborhood = /* @__PURE__ */ new Set();
  const visibleIds = new Set(visible.map((n2) => n2.id));
  const links = data.links.filter((l2) => visibleIds.has(l2.source) && visibleIds.has(l2.target));
  const focus = focusId && visibleIds.has(focusId) ? data.nodes.find((n2) => n2.id === focusId) ?? null : null;
  if (!focus) {
    const groups = /* @__PURE__ */ new Map();
    for (const n2 of visible) {
      const key = n2.topic ?? n2.type;
      groups.set(key, [...groups.get(key) ?? [], n2]);
    }
    const keys = [...groups.keys()].sort((a2, b2) => groups.get(b2).length - groups.get(a2).length || a2.localeCompare(b2));
    keys.forEach((key, gi) => {
      const members = groups.get(key).slice().sort((a2, b2) => b2.importance - a2.importance || a2.id.localeCompare(b2.id));
      const angle = clusterAngle(key, keys);
      const clusterR = 150 + Math.min(180, keys.length * 6) + gi * 6;
      const cx = Math.cos(angle) * clusterR;
      const cy = Math.sin(angle) * clusterR;
      const inner = 14 + Math.sqrt(members.length) * 9;
      members.forEach((n2, i2) => {
        const a2 = i2 / members.length * Math.PI * 2 + angle;
        const r2 = members.length === 1 ? 0 : inner;
        pos.set(n2.id, { x: cx + Math.cos(a2) * r2, y: cy + Math.sin(a2) * r2 });
      });
    });
    for (const n2 of visible) neighborhood.add(n2.id);
    return { pos, neighborhood };
  }
  const byId = new Map(data.nodes.map((n2) => [n2.id, n2]));
  const adj = /* @__PURE__ */ new Map();
  for (const l2 of links) {
    (adj.get(l2.source) ?? adj.set(l2.source, /* @__PURE__ */ new Set()).get(l2.source)).add(l2.target);
    (adj.get(l2.target) ?? adj.set(l2.target, /* @__PURE__ */ new Set()).get(l2.target)).add(l2.source);
  }
  const sorted = (ids) => [...ids].filter((id) => id !== focus.id && visibleIds.has(id)).sort((a2, b2) => {
    const na = byId.get(a2);
    const nb = byId.get(b2);
    return (na.topic ?? "").localeCompare(nb.topic ?? "") || nb.importance - na.importance || a2.localeCompare(b2);
  });
  const hop1 = sorted(adj.get(focus.id) ?? []);
  const hop1Set = new Set(hop1);
  const hop2 = sorted(new Set([...hop1].flatMap((id) => [...adj.get(id) ?? []])).values()).filter((id) => !hop1Set.has(id));
  const placed = /* @__PURE__ */ new Set([focus.id, ...hop1, ...hop2]);
  for (const id of placed) neighborhood.add(id);
  pos.set(focus.id, { x: 0, y: 0 });
  const topics = [...new Set(hop1.map((id) => byId.get(id).topic ?? byId.get(id).type))].sort();
  hop1.forEach((id, i2) => {
    const n2 = byId.get(id);
    const base = clusterAngle(n2.topic ?? n2.type, topics);
    const span = Math.PI * 2 / Math.max(1, hop1.length);
    const angle = base + i2 / hop1.length * span;
    const r2 = 120 - n2.importance * 26 + hashJitter(id);
    pos.set(id, { x: Math.cos(angle) * r2, y: Math.sin(angle) * r2 });
  });
  const parentOf = /* @__PURE__ */ new Map();
  for (const id of hop2) {
    const p2 = [...adj.get(id) ?? []].find((x2) => hop1Set.has(x2));
    if (p2) parentOf.set(id, p2);
  }
  const byParent = /* @__PURE__ */ new Map();
  for (const [id, p2] of parentOf) byParent.set(p2, [...byParent.get(p2) ?? [], id]);
  for (const [parent, kids] of byParent) {
    const base = pos.get(parent);
    const baseAngle = Math.atan2(base.y, base.x);
    kids.forEach((id, i2) => {
      const a2 = baseAngle + (i2 - (kids.length - 1) / 2) * 0.34;
      const r2 = Math.hypot(base.x, base.y) + 92;
      pos.set(id, { x: Math.cos(a2) * r2 + hashJitter(id), y: Math.sin(a2) * r2 + hashJitter(id) });
    });
  }
  const rest = visible.filter((n2) => !placed.has(n2.id)).sort((a2, b2) => a2.id.localeCompare(b2.id));
  rest.forEach((n2, i2) => {
    const a2 = i2 / Math.max(1, rest.length) * Math.PI * 2;
    pos.set(n2.id, { x: Math.cos(a2) * 340, y: Math.sin(a2) * 340 });
  });
  return { pos, neighborhood };
}
function edgeStyleKind(link) {
  return EDGE_STYLE[link.kind] ? link.kind : "related";
}
function Graph({
  data,
  selected,
  onSelect,
  focus,
  onFocus,
  onOpen
}) {
  const [kinds, setKinds] = d(() => new Set(RAIL_EDGE_ORDER.filter((k2) => data.links.some((l2) => l2.kind === k2))));
  const [states, setStates] = d(() => /* @__PURE__ */ new Set(["active", "cold"]));
  const [hover, setHover] = d(null);
  const [query, setQuery] = d("");
  const [showList, setShowList] = d(true);
  const [view, setView] = d({ k: 1, x: 0, y: 0 });
  const [size, setSize] = d({ w: 900, h: 620 });
  const [manual, setManual] = d(/* @__PURE__ */ new Map());
  const [panning, setPanning] = d(false);
  const ref = A(null);
  const drag = A(null);
  const dragged = A(false);
  const visible = T(
    () => data.nodes.filter((n2) => states.has(n2.state) && (!query || n2.label.toLowerCase().includes(query.toLowerCase()))),
    [data.nodes, states, query]
  );
  const visibleIds = T(() => new Set(visible.map((n2) => n2.id)), [visible]);
  const layout = T(() => layoutGraph(data, focus, visible), [data, focus, visible]);
  const base = layout.pos;
  const neighborhood = layout.neighborhood;
  const pos = T(() => {
    if (manual.size === 0) return base;
    const merged = new Map(base);
    for (const [id, p2] of manual) if (merged.has(id)) merged.set(id, p2);
    return merged;
  }, [base, manual]);
  const visibleLinks = T(
    () => data.links.filter((l2) => visibleIds.has(l2.source) && visibleIds.has(l2.target)),
    [data.links, visibleIds]
  );
  const links = T(() => visibleLinks.filter((l2) => kinds.has(edgeStyleKind(l2))), [visibleLinks, kinds]);
  const labels = T(() => {
    const ids = /* @__PURE__ */ new Set();
    for (const id of [focus, hover, selected]) if (id) ids.add(id);
    const placed = [];
    for (const id of [focus, hover, selected]) {
      const p2 = base.get(id ?? "");
      if (p2) placed.push(p2);
    }
    for (const n2 of visible.slice().sort((a2, b2) => b2.importance - a2.importance)) {
      if (ids.size > 12) break;
      if (ids.has(n2.id)) continue;
      const p2 = base.get(n2.id);
      if (!p2) continue;
      if (placed.some((q2) => Math.hypot(q2.x - p2.x, q2.y - p2.y) < 46)) continue;
      placed.push(p2);
      ids.add(n2.id);
    }
    return ids;
  }, [visible, base, focus, hover, selected]);
  h(() => setManual(/* @__PURE__ */ new Map()), [focus]);
  h(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r2 = el.getBoundingClientRect();
      if (r2.width > 0 && r2.height > 0) setSize({ w: r2.width, h: r2.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  h(() => {
    setKinds((prev) => {
      const present = new Set(visibleLinks.map((l2) => edgeStyleKind(l2)));
      const next = new Set([...prev].filter((kk) => present.has(kk)));
      for (const kk of present) next.add(kk);
      return next;
    });
  }, [visibleLinks]);
  const fit = q(() => {
    if (focus) {
      setView({ k: 1, x: 0, y: 0 });
      return;
    }
    const pts = [...base.values()];
    if (pts.length === 0) return;
    const xs = pts.map((p2) => p2.x);
    const ys = pts.map((p2) => p2.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w2 = Math.max(1, maxX - minX);
    const h2 = Math.max(1, maxY - minY);
    const k2 = Math.min(1.15, Math.max(0.3, Math.min((size.w - 260) / w2, (size.h - 180) / h2)));
    setView({ k: k2, x: -((minX + maxX) / 2) * k2, y: -((minY + maxY) / 2) * k2 });
  }, [base, focus, size]);
  h(() => {
    fit();
  }, [fit]);
  const toWorld = q(
    (clientX, clientY) => {
      const svg = ref.current;
      const r2 = svg.getBoundingClientRect();
      const cx = r2.width / 2;
      const cy = r2.height / 2;
      return { x: (clientX - r2.left - cx - view.x) / view.k, y: (clientY - r2.top - cy - view.y) / view.k };
    },
    [view]
  );
  const onWheel = (e2) => {
    e2.preventDefault();
    const factor = e2.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(2.6, Math.max(0.32, view.k * factor));
    const svg = ref.current;
    const r2 = svg.getBoundingClientRect();
    const px = e2.clientX - r2.left - r2.width / 2;
    const py = e2.clientY - r2.top - r2.height / 2;
    const ratio = next / view.k;
    setView({ k: next, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio });
  };
  h(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });
  const onPointerDown = (e2) => {
    const pt = toWorld(e2.clientX, e2.clientY);
    drag.current = { id: null, startX: e2.clientX, startY: e2.clientY, originX: pt.x, originY: pt.y };
    dragged.current = false;
    setPanning(true);
  };
  const onPointerMove = (e2) => {
    const d2 = drag.current;
    if (!d2) return;
    if (Math.abs(e2.clientX - d2.startX) > 4 || Math.abs(e2.clientY - d2.startY) > 4) dragged.current = true;
    if (d2.id) {
      const x2 = d2.originX + (e2.clientX - d2.startX) / view.k;
      const y2 = d2.originY + (e2.clientY - d2.startY) / view.k;
      setManual((m2) => new Map(m2).set(d2.id, { x: x2, y: y2 }));
    } else {
      setView((v2) => ({ ...v2, x: v2.x + (e2.clientX - d2.startX), y: v2.y + (e2.clientY - d2.startY) }));
      drag.current = { ...d2, startX: e2.clientX, startY: e2.clientY };
    }
  };
  const onPointerUp = () => {
    drag.current = null;
    setPanning(false);
  };
  const startNodeDrag = (n2, e2) => {
    e2.stopPropagation();
    const p2 = pos.get(n2.id);
    if (!p2) return;
    drag.current = { id: n2.id, startX: e2.clientX, startY: e2.clientY, originX: p2.x, originY: p2.y };
    dragged.current = false;
  };
  const onKeyDown = (e2) => {
    if (e2.key === "Escape") {
      e2.stopPropagation();
      if (focus) onFocus(null);
      else onSelect(null);
      return;
    }
    if (e2.key === "f") {
      fit();
      return;
    }
    if (e2.key !== "ArrowUp" && e2.key !== "ArrowDown" && e2.key !== "ArrowLeft" && e2.key !== "ArrowRight") return;
    e2.preventDefault();
    const cur = selected ?? focus;
    const here = cur ? pos.get(cur) : null;
    const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e2.key];
    let best = null;
    for (const [id, p2] of pos) {
      if (id === cur) continue;
      const dx = p2.x - (here?.x ?? 0);
      const dy = p2.y - (here?.y ?? 0);
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 6) continue;
      const side = Math.abs(dx * dir[1] - dy * dir[0]);
      const score = along + side * 2;
      if (!best || score < best.score) best = { id, score };
    }
    if (best) {
      onSelect(best.id);
      if (e2.shiftKey) onFocus(best.id);
    }
  };
  if (data.nodes.length === 0) {
    return /* @__PURE__ */ u$1("div", { class: "graph", children: /* @__PURE__ */ u$1(
      EmptyState,
      {
        title: "库里还没有可画的节点",
        hint: /* @__PURE__ */ u$1(S, { children: [
          "图谱画的是 active / cold 的记忆和它们之间的关系。安静用一轮 pi，或者切到全局库看看：",
          /* @__PURE__ */ u$1("br", {}),
          /* @__PURE__ */ u$1("code", { children: 'pi -p "记住：这个项目的测试统一跑 node tests/smoke.ts"' })
        ] })
      }
    ) });
  }
  const activeEdgeKinds = RAIL_EDGE_ORDER.filter((kk) => visibleLinks.some((l2) => edgeStyleKind(l2) === kk));
  const focusNode = focus ? data.nodes.find((n2) => n2.id === focus) ?? null : null;
  return /* @__PURE__ */ u$1("div", { class: `graph ${showList ? "has-list" : ""}`, children: [
    showList ? /* @__PURE__ */ u$1("div", { class: "graph-list", children: [
      /* @__PURE__ */ u$1("div", { style: { position: "sticky", top: 0, zIndex: 1, padding: "8px", background: "var(--surface)", borderBottom: "1px solid var(--line)" }, children: [
        /* @__PURE__ */ u$1(SearchInput, { value: query, onInput: setQuery, placeholder: "过滤节点" }),
        /* @__PURE__ */ u$1("div", { class: "dim", style: { marginTop: "6px", fontSize: "11.5px" }, children: [
          visible.length,
          " / ",
          data.nodes.length,
          " 个节点"
        ] })
      ] }),
      visible.slice().sort((a2, b2) => b2.importance - a2.importance || a2.id.localeCompare(b2.id)).map((n2) => /* @__PURE__ */ u$1("div", { class: "row", role: "button", tabindex: -1, "aria-selected": selected === n2.id, onClick: () => onSelect(n2.id), onDblClick: () => onOpen(n2.id), title: n2.label, children: [
        /* @__PURE__ */ u$1("span", { class: `dot ${n2.state}` }),
        /* @__PURE__ */ u$1("span", { class: "truncate", children: n2.label })
      ] }, n2.id))
    ] }) : null,
    /* @__PURE__ */ u$1("div", { class: "graph-canvas", children: [
      /* @__PURE__ */ u$1("div", { class: "graph-overlay", children: [
        /* @__PURE__ */ u$1(Button, { size: "sm", variant: "ghost", icon: "list", onClick: () => setShowList((v2) => !v2), children: showList ? "隐藏列表" : "节点列表" }),
        focusNode ? /* @__PURE__ */ u$1(S, { children: [
          /* @__PURE__ */ u$1(Chip, { tone: "accent", title: focusNode.label, children: [
            "焦点 ",
            shortId(focusNode.id)
          ] }),
          /* @__PURE__ */ u$1(Button, { size: "sm", variant: "ghost", onClick: () => onFocus(null), children: "回到全库" })
        ] }) : /* @__PURE__ */ u$1(Chip, { tone: "", children: "全库概览（点击节点看邻居）" }),
        /* @__PURE__ */ u$1("span", { class: "spacer" }),
        activeEdgeKinds.map((kk) => /* @__PURE__ */ u$1(
          "button",
          {
            type: "button",
            class: `chip ${kinds.has(kk) ? "accent" : ""}`,
            "aria-pressed": kinds.has(kk),
            onClick: () => setKinds((s2) => {
              const next = new Set(s2);
              if (next.has(kk)) next.delete(kk);
              else next.add(kk);
              return next;
            }),
            children: KIND_LABEL[kk] ?? kk
          },
          kk
        )),
        ["active", "cold", "archived", "superseded"].filter((s2) => data.nodes.some((n2) => n2.state === s2)).map((s2) => /* @__PURE__ */ u$1(
          "button",
          {
            type: "button",
            class: `chip ${states.has(s2) ? "accent" : ""}`,
            "aria-pressed": states.has(s2),
            onClick: () => setStates((prev) => {
              const next = new Set(prev);
              if (next.has(s2)) next.delete(s2);
              else next.add(s2);
              return next;
            }),
            children: STATE_LABEL[s2] ?? s2
          },
          s2
        ))
      ] }),
      /* @__PURE__ */ u$1(
        "svg",
        {
          ref,
          tabindex: 0,
          class: panning ? "panning" : "",
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerLeave: onPointerUp,
          onKeyDown,
          role: "application",
          "aria-label": "记忆关系图",
          children: /* @__PURE__ */ u$1("g", { transform: `translate(${size.w / 2 + view.x} ${size.h / 2 + view.y}) scale(${view.k})`, children: [
            links.map((l2, i2) => {
              const a2 = pos.get(l2.source);
              const b2 = pos.get(l2.target);
              if (!a2 || !b2) return null;
              const st = EDGE_STYLE[edgeStyleKind(l2)];
              const hot = hover === l2.source || hover === l2.target || selected === l2.source || selected === l2.target;
              return /* @__PURE__ */ u$1(
                "line",
                {
                  class: "graph-edge",
                  x1: a2.x,
                  y1: a2.y,
                  x2: b2.x,
                  y2: b2.y,
                  stroke: st.tone,
                  "stroke-width": hot ? 1.6 : 1,
                  "stroke-dasharray": st.dash,
                  opacity: hot ? 0.95 : hover || selected ? 0.28 : 0.55
                },
                `${l2.source}-${l2.target}-${i2}`
              );
            }),
            [...pos.entries()].map(([id, p2]) => {
              const n2 = data.nodes.find((x2) => x2.id === id);
              if (!n2) return null;
              const r2 = 4 + n2.importance * 7;
              const isFocus = focus === id;
              const isSel = selected === id;
              const linkedToSelected = selected != null && visibleLinks.some((l2) => l2.source === selected && l2.target === id || l2.target === selected && l2.source === id);
              const dim = hover != null && hover !== id || selected != null && !isSel && !linkedToSelected || hover == null && selected == null && focus != null && !neighborhood.has(id);
              return /* @__PURE__ */ u$1(
                "g",
                {
                  class: "graph-node",
                  transform: `translate(${p2.x} ${p2.y})`,
                  opacity: dim ? 0.34 : 1,
                  onPointerDown: (e2) => startNodeDrag(n2, e2),
                  onPointerEnter: () => setHover(id),
                  onPointerLeave: () => setHover((h2) => h2 === id ? null : h2),
                  onClick: (e2) => {
                    e2.stopPropagation();
                    if (dragged.current) return;
                    if (e2.altKey || e2.detail === 2) onOpen(id);
                    else {
                      onSelect(id);
                      onFocus(id);
                    }
                  },
                  tabindex: 0,
                  role: "button",
                  "aria-label": `${TYPE_LABEL[n2.type] ?? n2.type}：${n2.label}`,
                  children: [
                    /* @__PURE__ */ u$1(
                      "circle",
                      {
                        r: r2,
                        fill: n2.state === "cold" ? "var(--warn)" : isFocus ? "var(--accent)" : "var(--surface-2)",
                        stroke: n2.state === "active" ? "var(--accent)" : n2.state === "cold" ? "var(--warn)" : "var(--fg-faint)",
                        "stroke-width": isSel ? 2.4 : 1.4
                      }
                    ),
                    n2.state === "superseded" ? /* @__PURE__ */ u$1("line", { x1: -r2, y1: r2, x2: r2, y2: -r2, stroke: "var(--bad)", "stroke-width": "1.4" }) : null,
                    isFocus ? /* @__PURE__ */ u$1("circle", { r: r2 + 5, fill: "none", stroke: "var(--accent)", "stroke-width": "1", opacity: "0.5" }) : null,
                    labels.has(id) ? /* @__PURE__ */ u$1("text", { class: `graph-label ${isFocus || isSel ? "focus" : ""}`, y: -r2 - 6, "text-anchor": "middle", children: n2.label.slice(0, 26) }) : null,
                    /* @__PURE__ */ u$1("title", { children: [n2.label, `${TYPE_LABEL[n2.type] ?? n2.type} / ${STATE_LABEL[n2.state] ?? n2.state}`, n2.topic ?? ""].filter(Boolean).join("\n") })
                  ]
                },
                id
              );
            })
          ] })
        }
      ),
      /* @__PURE__ */ u$1("div", { class: "graph-legend", children: activeEdgeKinds.filter((kk) => kinds.has(kk)).map((kk) => /* @__PURE__ */ u$1("div", { class: "row", children: [
        /* @__PURE__ */ u$1("svg", { viewBox: "0 0 26 8", children: /* @__PURE__ */ u$1("line", { x1: "1", y1: "4", x2: "25", y2: "4", stroke: EDGE_STYLE[kk].tone, "stroke-width": "1.4", "stroke-dasharray": EDGE_STYLE[kk].dash }) }),
        KIND_LABEL[kk] ?? kk
      ] }, kk)) }),
      visibleLinks.length === 0 ? /* @__PURE__ */ u$1("div", { class: "graph-hint", style: { right: "auto", left: "50%", transform: "translateX(-50%)", color: "var(--fg-dim)" }, children: "这些记忆之间还没有关系。同主题、同路径、取代/冲突、高相似会自动连成边。" }) : null,
      /* @__PURE__ */ u$1("div", { class: "graph-hint", children: [
        /* @__PURE__ */ u$1(KeyHint, { keys: ["方向键"] }),
        " 选节点 ",
        /* @__PURE__ */ u$1(KeyHint, { keys: ["Enter"] }),
        " 看详情 ",
        /* @__PURE__ */ u$1(KeyHint, { keys: ["F"] }),
        " 适配 ",
        /* @__PURE__ */ u$1(KeyHint, { keys: ["Esc"] }),
        " 回全库"
      ] })
    ] })
  ] });
}
function OverviewView({ scope, version }) {
  const { data, error, loading, reload } = useAsync(() => api.overview(scope), [scope, version]);
  if (loading && !data) return /* @__PURE__ */ u$1(Skeleton, { rows: 6 });
  if (error) return /* @__PURE__ */ u$1(ErrorNote, { error, onRetry: reload });
  if (!data) return null;
  const o2 = data;
  const byState = o2.project.byState ?? {};
  const total = o2.project.count;
  const active = byState.active ?? 0;
  return /* @__PURE__ */ u$1("div", { class: "view", children: [
    /* @__PURE__ */ u$1("div", { class: "view-head", children: [
      /* @__PURE__ */ u$1("h1", { children: "概览" }),
      /* @__PURE__ */ u$1("span", { class: "sub dim", children: [
        scope === "global" ? "全局库" : "项目库",
        " ",
        total,
        " 条，其中 active ",
        active,
        " 条"
      ] }),
      /* @__PURE__ */ u$1("span", { class: "spacer" }),
      /* @__PURE__ */ u$1(Button, { variant: "ghost", icon: "refresh", onClick: reload, children: "刷新" })
    ] }),
    /* @__PURE__ */ u$1("div", { class: "metrics", children: [
      /* @__PURE__ */ u$1(Metric, { k: "注入命中率", v: o2.hitRate == null ? "-" : pct(o2.hitRate), h: o2.injectedTotal ? `注入 ${o2.injectedTotal} 条，用过 ${o2.citedTotal} 条` : "本会话还没注入过" }),
      /* @__PURE__ */ u$1(Metric, { k: "待确认", v: String(o2.pending), h: "合并 / 冲突 / 起主题" }),
      /* @__PURE__ */ u$1(Metric, { k: "近义堆", v: String(o2.dupes), h: `余弦 ≥ ${fixed(o2.dupeCosine, 2)}` }),
      /* @__PURE__ */ u$1(Metric, { k: "路径节点", v: String(o2.project.paths), h: "来自 tool call 的文件名" }),
      /* @__PURE__ */ u$1(Metric, { k: "全局库", v: String(o2.global.count), h: o2.global.file.split("/").slice(-1)[0] }),
      /* @__PURE__ */ u$1(Metric, { text: true, k: "判断引擎", v: o2.engine.ready ? o2.engine.model ?? "已配置" : "不可用", h: o2.engine.ready ? `${o2.engine.provider} · 阈值 ${fixed(o2.engine.relevanceThreshold, 2)}` : o2.engine.problems[0] ?? "" })
    ] }),
    /* @__PURE__ */ u$1(Panel, { title: "召回健康度", actions: /* @__PURE__ */ u$1("span", { class: "dim", children: [
      "最近 ",
      o2.recalls.length,
      " 次"
    ] }), flush: true, children: o2.recalls.length === 0 ? /* @__PURE__ */ u$1(EmptyState, { title: "还没有召回记录", hint: "新会话第一次提问时，判断引擎会决定要不要查记忆，这里记录结果。" }) : /* @__PURE__ */ u$1("div", { children: [
      /* @__PURE__ */ u$1("div", { class: "recall-row dim", style: { fontSize: "11.5px" }, children: [
        /* @__PURE__ */ u$1("span", { children: "提问" }),
        /* @__PURE__ */ u$1("span", { style: { textAlign: "right" }, children: "候选" }),
        /* @__PURE__ */ u$1("span", { style: { textAlign: "right" }, children: "注入" }),
        /* @__PURE__ */ u$1("span", { style: { textAlign: "right" }, children: "用上" })
      ] }),
      o2.recalls.map((r2, i2) => /* @__PURE__ */ u$1("div", { class: "recall-row", children: [
        /* @__PURE__ */ u$1("span", { class: "truncate", title: r2.query, children: r2.query }),
        /* @__PURE__ */ u$1("span", { class: "n", children: r2.recalled }),
        /* @__PURE__ */ u$1("span", { class: "n", children: r2.injected }),
        /* @__PURE__ */ u$1("span", { class: "n", style: { color: r2.cited > 0 ? "var(--accent)" : "var(--fg-faint)" }, children: r2.cited })
      ] }, `${r2.at}-${i2}`))
    ] }) }),
    /* @__PURE__ */ u$1(Panel, { title: "最近判断", flush: true, children: o2.traces.length === 0 ? /* @__PURE__ */ u$1(EmptyState, { title: "还没有判断轨迹" }) : /* @__PURE__ */ u$1("div", { class: "panel-body", children: /* @__PURE__ */ u$1("div", { class: "timeline", children: o2.traces.map((t2, i2) => /* @__PURE__ */ u$1("div", { class: "timeline-item", children: [
      /* @__PURE__ */ u$1("div", { class: "gate", children: [
        t2.gate,
        /* @__PURE__ */ u$1("br", {}),
        /* @__PURE__ */ u$1("span", { class: "faint", children: t2.action })
      ] }),
      /* @__PURE__ */ u$1("div", { class: "what", children: [
        /* @__PURE__ */ u$1("div", { children: t2.userVisible || humanTrace(t2.gate, t2.action) }),
        t2.reason ? /* @__PURE__ */ u$1("div", { class: "dim", children: t2.reason }) : null
      ] })
    ] }, `${t2.gate}-${i2}`)) }) }) }),
    /* @__PURE__ */ u$1(Panel, { title: "项目注册表", flush: true, children: o2.registry.length === 0 ? /* @__PURE__ */ u$1(EmptyState, { title: "还没有别的项目", hint: "在别的目录里用一次 pi，它就会登记进来（跨项目召回靠这张表）。" }) : /* @__PURE__ */ u$1("table", { class: "grid", children: [
      /* @__PURE__ */ u$1("thead", { children: /* @__PURE__ */ u$1("tr", { children: [
        /* @__PURE__ */ u$1("th", { children: "项目" }),
        /* @__PURE__ */ u$1("th", { class: "hide-sm", children: "目录" }),
        /* @__PURE__ */ u$1("th", { style: { width: "80px", textAlign: "right" }, children: "记忆" }),
        /* @__PURE__ */ u$1("th", { style: { width: "110px" }, children: "更新" })
      ] }) }),
      /* @__PURE__ */ u$1("tbody", { children: o2.registry.map((p2) => /* @__PURE__ */ u$1("tr", { style: { cursor: "default" }, children: [
        /* @__PURE__ */ u$1("td", { children: p2.project_id }),
        /* @__PURE__ */ u$1("td", { class: "hide-sm mono truncate", title: p2.dir, children: p2.dir }),
        /* @__PURE__ */ u$1("td", { class: "num", children: p2.memory_count }),
        /* @__PURE__ */ u$1("td", { children: /* @__PURE__ */ u$1(TimeCell, { at: p2.updated_at }) })
      ] }, p2.project_id)) })
    ] }) }),
    /* @__PURE__ */ u$1(Panel, { title: "引擎与文件", children: /* @__PURE__ */ u$1("dl", { class: "meta-grid", children: [
      /* @__PURE__ */ u$1("dt", { children: "项目库" }),
      /* @__PURE__ */ u$1("dd", { class: "mono truncate", title: o2.project.file, children: o2.project.file }),
      /* @__PURE__ */ u$1("dt", { children: "全局库" }),
      /* @__PURE__ */ u$1("dd", { class: "mono truncate", title: o2.global.file, children: o2.global.file }),
      /* @__PURE__ */ u$1("dt", { children: "端点" }),
      /* @__PURE__ */ u$1("dd", { class: "mono", children: o2.engine.baseUrl ?? "-" }),
      /* @__PURE__ */ u$1("dt", { children: "模型" }),
      /* @__PURE__ */ u$1("dd", { class: "mono", children: o2.engine.model ?? "-" }),
      o2.engine.problems.length > 0 ? /* @__PURE__ */ u$1(S, { children: [
        /* @__PURE__ */ u$1("dt", { children: "配置问题" }),
        /* @__PURE__ */ u$1("dd", { children: o2.engine.problems.map((p2) => /* @__PURE__ */ u$1("div", { class: "dim", children: p2 }, p2)) })
      ] }) : null
    ] }) })
  ] });
}
function MemoriesView({ scope, version, query, onQuery, selected, onSelect }) {
  const [state, setState] = d("");
  const [type, setType] = d("");
  const [topic, setTopic] = d("");
  const { data, error, loading, reload } = useAsync(() => api.memories(scope, { state, topic }), [scope, state, topic, version]);
  const items = T(() => {
    const all = data?.items ?? [];
    const q2 = query.trim().toLowerCase();
    return all.filter((m2) => (!type || m2.type === type) && (!q2 || m2.content.toLowerCase().includes(q2) || m2.id.startsWith(q2) || (m2.topic ?? "").toLowerCase().includes(q2)));
  }, [data, type, query]);
  h(() => {
    const onKey = (e2) => {
      const target = e2.target;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      if (e2.key !== "j" && e2.key !== "k") return;
      if (e2.metaKey || e2.ctrlKey || e2.altKey) return;
      const i2 = items.findIndex((m2) => m2.id === selected);
      e2.preventDefault();
      const next = e2.key === "j" ? Math.min(items.length - 1, i2 + 1) : Math.max(0, i2 - 1);
      const pick = items[next < 0 ? 0 : next];
      if (pick) onSelect(pick.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selected, onSelect]);
  const counts = T(() => {
    const map = /* @__PURE__ */ new Map();
    for (const m2 of data?.items ?? []) map.set(m2.type, (map.get(m2.type) ?? 0) + 1);
    return map;
  }, [data]);
  return /* @__PURE__ */ u$1("div", { class: "view", children: [
    /* @__PURE__ */ u$1("div", { class: "view-head", children: [
      /* @__PURE__ */ u$1("h1", { children: "记忆" }),
      /* @__PURE__ */ u$1("span", { class: "sub dim", children: [
        "共 ",
        data?.items.length ?? 0,
        " 条，筛出 ",
        items.length,
        " 条"
      ] }),
      /* @__PURE__ */ u$1("span", { class: "spacer" }),
      /* @__PURE__ */ u$1(KeyHint, { keys: ["J", "K"] }),
      /* @__PURE__ */ u$1("span", { class: "dim", children: "切换" })
    ] }),
    /* @__PURE__ */ u$1("div", { class: "toolbar", children: [
      /* @__PURE__ */ u$1(SearchInput, { value: query, onInput: onQuery, placeholder: "按内容 / id / 主题过滤" }),
      /* @__PURE__ */ u$1("select", { class: "select", value: state, onChange: (e2) => setState(e2.currentTarget.value), "aria-label": "状态", children: [
        /* @__PURE__ */ u$1("option", { value: "", children: "全部状态" }),
        ["active", "cold", "archived", "superseded"].map((s2) => /* @__PURE__ */ u$1("option", { value: s2, children: STATE_LABEL[s2] ?? s2 }, s2))
      ] }),
      /* @__PURE__ */ u$1("select", { class: "select", value: type, onChange: (e2) => setType(e2.currentTarget.value), "aria-label": "类型", children: [
        /* @__PURE__ */ u$1("option", { value: "", children: "全部类型" }),
        Object.keys(TYPE_LABEL).map((t2) => /* @__PURE__ */ u$1("option", { value: t2, children: [
          TYPE_LABEL[t2],
          counts.get(t2) ? ` (${counts.get(t2)})` : ""
        ] }, t2))
      ] }),
      /* @__PURE__ */ u$1("select", { class: "select", value: topic, onChange: (e2) => setTopic(e2.currentTarget.value), "aria-label": "主题", children: [
        /* @__PURE__ */ u$1("option", { value: "", children: "全部主题" }),
        (data?.topics ?? []).map((t2) => /* @__PURE__ */ u$1("option", { value: t2, children: t2 }, t2))
      ] }),
      /* @__PURE__ */ u$1("span", { class: "spacer" }),
      /* @__PURE__ */ u$1(Button, { variant: "ghost", icon: "refresh", onClick: reload, children: "刷新" })
    ] }),
    /* @__PURE__ */ u$1("div", { class: "panel", children: loading && !data ? /* @__PURE__ */ u$1(Skeleton, { rows: 8 }) : error ? /* @__PURE__ */ u$1(ErrorNote, { error, onRetry: reload }) : items.length === 0 ? /* @__PURE__ */ u$1(
      EmptyState,
      {
        title: query || state || type || topic ? "没有符合条件的记忆" : "这个库里还没有记忆",
        hint: query || state || type || topic ? "换个筛选条件，或者清空搜索框。" : /* @__PURE__ */ u$1(S, { children: [
          "写入是自动的：跟 pi 说一句持久的约定就行。",
          /* @__PURE__ */ u$1("br", {}),
          /* @__PURE__ */ u$1("code", { children: 'pi -p "以后这个项目的测试统一跑 node tests/smoke.ts"' })
        ] })
      }
    ) : /* @__PURE__ */ u$1("table", { class: "grid", children: [
      /* @__PURE__ */ u$1("thead", { children: /* @__PURE__ */ u$1("tr", { children: [
        /* @__PURE__ */ u$1("th", { style: { width: "104px" }, children: "状态" }),
        /* @__PURE__ */ u$1("th", { style: { width: "72px" }, class: "hide-sm", children: "类型" }),
        /* @__PURE__ */ u$1("th", { children: "内容" }),
        /* @__PURE__ */ u$1("th", { style: { width: "120px" }, class: "hide-sm", children: "主题" }),
        /* @__PURE__ */ u$1("th", { style: { width: "64px", textAlign: "right" }, children: "重要度" }),
        /* @__PURE__ */ u$1("th", { style: { width: "96px" }, children: "写入" })
      ] }) }),
      /* @__PURE__ */ u$1("tbody", { children: items.map((m2) => /* @__PURE__ */ u$1("tr", { tabindex: 0, "aria-selected": selected === m2.id, onClick: () => onSelect(m2.id), children: [
        /* @__PURE__ */ u$1("td", { children: [
          /* @__PURE__ */ u$1(StateChip, { state: m2.state }),
          m2.scope !== "project" ? /* @__PURE__ */ u$1(Chip, { title: m2.scopeId ?? "", children: SCOPE_LABEL[m2.scope] ?? m2.scope }) : null
        ] }),
        /* @__PURE__ */ u$1("td", { class: "hide-sm", children: /* @__PURE__ */ u$1(TypeChip, { type: m2.type }) }),
        /* @__PURE__ */ u$1("td", { class: "cell-content truncate", title: m2.content, children: m2.content }),
        /* @__PURE__ */ u$1("td", { class: "hide-sm truncate dim", children: m2.topic ?? "-" }),
        /* @__PURE__ */ u$1("td", { class: "num", children: fixed(m2.importance, 2) }),
        /* @__PURE__ */ u$1("td", { children: /* @__PURE__ */ u$1(TimeCell, { at: m2.createdAt }) })
      ] }, m2.id)) })
    ] }) })
  ] });
}
function PendingView({ scope, version, onChanged, onOpenMemory }) {
  const { data, error, loading, reload } = useAsync(() => api.memories(scope), [scope, version]);
  const [busy, setBusy] = d(false);
  const items = data?.pending ?? [];
  const current = items[0];
  const resolve = async (resolution) => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const r2 = await api.resolveReview(current.id, resolution);
      toast(r2.result ? `已处理：${r2.result}` : "已处理");
      reload();
      onChanged();
    } catch (e2) {
      toast(e2.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const options = current ? JSON.parse(current.options) : [];
  const isTopic = current?.kind === "topic";
  h(() => {
    const onKey = (e2) => {
      const n2 = Number(e2.key);
      if (!Number.isInteger(n2) || n2 < 1 || n2 > options.length) return;
      const target = e2.target;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      void resolve(options[n2 - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return /* @__PURE__ */ u$1("div", { class: "view", children: [
    /* @__PURE__ */ u$1("div", { class: "view-head", children: [
      /* @__PURE__ */ u$1("h1", { children: "待确认" }),
      /* @__PURE__ */ u$1("span", { class: "sub dim", children: items.length > 0 ? `还有 ${items.length} 条等你拍` : "队列是空的" }),
      /* @__PURE__ */ u$1("span", { class: "spacer" }),
      /* @__PURE__ */ u$1("span", { class: "dim", children: [
        "按 ",
        /* @__PURE__ */ u$1(KeyHint, { keys: ["1"] }),
        " 到 ",
        /* @__PURE__ */ u$1(KeyHint, { keys: ["9"] }),
        " 直接选"
      ] }),
      /* @__PURE__ */ u$1(Button, { variant: "ghost", icon: "refresh", onClick: reload, children: "刷新" })
    ] }),
    error ? /* @__PURE__ */ u$1(ErrorNote, { error, onRetry: reload }) : loading && !data ? /* @__PURE__ */ u$1(Skeleton, { rows: 4 }) : !current ? /* @__PURE__ */ u$1(Panel, { children: /* @__PURE__ */ u$1(EmptyState, { title: "没有待确认的事", hint: "判不准的（合并、冲突、起主题、要不要放宽到全局）会排在这里，不会替你拍。" }) }) : /* @__PURE__ */ u$1(S, { children: [
      /* @__PURE__ */ u$1("div", { class: "progress", style: { marginBottom: "12px" }, children: /* @__PURE__ */ u$1("i", { style: { width: `${1 / items.length * 100}%` } }) }),
      /* @__PURE__ */ u$1(Panel, { title: `${current.kind === "merge" ? "合并" : current.kind === "conflict" ? "冲突" : current.kind === "scope" ? "作用域" : "起主题"} · 第 1 / ${items.length} 条`, children: /* @__PURE__ */ u$1("div", { class: "review-card", children: [
        /* @__PURE__ */ u$1("div", { class: "review-q", children: current.question }),
        isTopic ? /* @__PURE__ */ u$1(TopicForm, { busy, onSubmit: resolve }) : /* @__PURE__ */ u$1("div", { class: "review-options", children: options.map((o2, i2) => /* @__PURE__ */ u$1("button", { type: "button", class: "review-option", disabled: busy, onClick: () => void resolve(o2), children: [
          /* @__PURE__ */ u$1("span", { class: "idx", children: i2 + 1 }),
          /* @__PURE__ */ u$1("span", { children: o2 })
        ] }, o2)) }),
        /* @__PURE__ */ u$1("div", { class: "toolbar", style: { marginTop: "12px", marginBottom: 0 }, children: [
          current.kind === "merge" || current.kind === "conflict" ? /* @__PURE__ */ u$1(S, { children: [
            /* @__PURE__ */ u$1(Button, { variant: "ghost", onClick: () => onOpenMemory(current.memoryId), children: "看新记的这条" }),
            current.otherId ? /* @__PURE__ */ u$1(Button, { variant: "ghost", onClick: () => onOpenMemory(current.otherId), children: "看已有的那条" }) : null
          ] }) : /* @__PURE__ */ u$1(Button, { variant: "ghost", onClick: () => onOpenMemory(current.memoryId), children: "看这条原文" }),
          /* @__PURE__ */ u$1("span", { class: "spacer" }),
          /* @__PURE__ */ u$1(Button, { variant: "ghost", onClick: () => void resolve(""), disabled: busy, children: "先放着（跳过）" })
        ] })
      ] }) })
    ] })
  ] });
}
function TopicForm({ busy, onSubmit }) {
  const [name, setName] = d("");
  return /* @__PURE__ */ u$1("div", { class: "review-options", children: [
    /* @__PURE__ */ u$1(Field, { label: "主题名", hint: "引擎不许自己造词，名字由你起；起过之后同名主题会参与召回。", children: /* @__PURE__ */ u$1(
      "input",
      {
        class: "input",
        value: name,
        placeholder: "例如：提交流程",
        onInput: (e2) => setName(e2.currentTarget.value),
        onKeyDown: (e2) => e2.key === "Enter" && name.trim() && onSubmit(name.trim())
      }
    ) }),
    /* @__PURE__ */ u$1("div", { style: { display: "flex", gap: "8px" }, children: [
      /* @__PURE__ */ u$1(Button, { variant: "primary", disabled: busy || !name.trim(), onClick: () => onSubmit(name.trim()), children: "用这个名字" }),
      /* @__PURE__ */ u$1(Button, { variant: "ghost", disabled: busy, onClick: () => onSubmit("先不起主题"), children: "先不起" })
    ] })
  ] });
}
function DupesView({ scope, version, onOpenMemory, onChanged }) {
  const { data, error, loading, reload } = useAsync(() => api.dupes(scope), [scope, version]);
  const [skipped, setSkipped] = d(/* @__PURE__ */ new Set());
  const [busy, setBusy] = d(false);
  const merge = async (keep, drop) => {
    setBusy(true);
    try {
      await api.merge(keep, drop);
      toast("已合并（旧原文留在 metadata 里，可查）");
      reload();
      onChanged();
    } catch (e2) {
      toast(e2.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const pairs = (data?.items ?? []).filter((d2) => !skipped.has(`${d2.a}-${d2.b}`));
  return /* @__PURE__ */ u$1("div", { class: "view", children: [
    /* @__PURE__ */ u$1("div", { class: "view-head", children: [
      /* @__PURE__ */ u$1("h1", { children: "近义堆" }),
      /* @__PURE__ */ u$1("span", { class: "sub dim", children: [
        "余弦 ≥ ",
        fixed(data?.threshold ?? 0.85, 2),
        " 的两两组合，",
        pairs.length,
        " 堆"
      ] }),
      /* @__PURE__ */ u$1("span", { class: "spacer" }),
      /* @__PURE__ */ u$1(Button, { variant: "ghost", icon: "refresh", onClick: reload, children: "刷新" })
    ] }),
    loading && !data ? /* @__PURE__ */ u$1(Skeleton, { rows: 6 }) : error ? /* @__PURE__ */ u$1(ErrorNote, { error, onRetry: reload }) : pairs.length === 0 ? /* @__PURE__ */ u$1(Panel, { children: /* @__PURE__ */ u$1(EmptyState, { title: "没有近义堆", hint: "向量层是弱过滤器：这里只是把很像的两条摆出来给你看，合并与否由你决定。" }) }) : pairs.map((d2) => /* @__PURE__ */ u$1(
      Panel,
      {
        title: `相似度 ${(d2.sim * 100).toFixed(1)}%`,
        actions: /* @__PURE__ */ u$1(S, { children: [
          /* @__PURE__ */ u$1("span", { class: "mono faint", children: shortId(d2.a) }),
          /* @__PURE__ */ u$1("span", { class: "dim", children: "↔" }),
          /* @__PURE__ */ u$1("span", { class: "mono faint", children: shortId(d2.b) })
        ] }),
        flush: true,
        children: [
          /* @__PURE__ */ u$1("div", { class: "dupe", children: [
            { id: d2.a, text: d2.aText },
            { id: d2.b, text: d2.bText }
          ].map((side) => /* @__PURE__ */ u$1("div", { class: "dupe-side", children: [
            /* @__PURE__ */ u$1("div", { class: "dupe-sim faint", style: { marginBottom: "6px" }, children: shortId(side.id) }),
            /* @__PURE__ */ u$1("div", { class: "wrap", children: side.text })
          ] }, side.id)) }),
          /* @__PURE__ */ u$1("div", { class: "dupe-actions", children: [
            /* @__PURE__ */ u$1(Button, { variant: "primary", disabled: busy, onClick: () => void merge(d2.a, d2.b), children: "合并，保留左边原文" }),
            /* @__PURE__ */ u$1(Button, { disabled: busy, onClick: () => void merge(d2.b, d2.a), children: "合并，保留右边原文" }),
            /* @__PURE__ */ u$1(Button, { variant: "ghost", onClick: () => onOpenMemory(d2.a), children: "看左边" }),
            /* @__PURE__ */ u$1("span", { class: "spacer" }),
            /* @__PURE__ */ u$1(Button, { variant: "ghost", onClick: () => setSkipped((s2) => new Set(s2).add(`${d2.a}-${d2.b}`)), children: "这堆先放着" })
          ] })
        ]
      },
      `${d2.a}-${d2.b}`
    ))
  ] });
}
function SettingsView({ user, onSaved }) {
  const { data, error, loading, reload } = useAsync(() => api.config(), []);
  const cfgPath = data?.path ?? "";
  const [draft, setDraft] = d(null);
  const [apiKey, setApiKey] = d("");
  const [busy, setBusy] = d(false);
  const [dirty, setDirty] = d(false);
  h(() => {
    if (data) {
      setDraft(JSON.parse(JSON.stringify(data.raw)));
      setDirty(false);
    }
  }, [data]);
  const patch = (fn) => {
    if (!draft) return;
    const next = JSON.parse(JSON.stringify(draft));
    fn(next);
    setDraft(next);
    setDirty(true);
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const body = JSON.parse(JSON.stringify(draft));
      if (apiKey.trim()) body.typesafe.apiKey = apiKey.trim();
      await api.saveConfig(body);
      setApiKey("");
      toast("已写入 config.json（权限 600）。判断引擎和端口要重启 pi 才生效");
      reload();
      onSaved();
    } catch (e2) {
      toast(e2.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  if (loading && !draft) return /* @__PURE__ */ u$1(Skeleton, { rows: 8 });
  if (error) return /* @__PURE__ */ u$1(ErrorNote, { error, onRetry: reload });
  if (!draft) return null;
  return /* @__PURE__ */ u$1("div", { class: "view", children: [
    /* @__PURE__ */ u$1("div", { class: "view-head", children: [
      /* @__PURE__ */ u$1("h1", { children: "设置" }),
      /* @__PURE__ */ u$1("span", { class: "sub dim", children: dirty ? "有改动没保存" : "已同步" }),
      /* @__PURE__ */ u$1("span", { class: "spacer" }),
      /* @__PURE__ */ u$1("span", { class: "dim mono truncate", title: cfgPath, children: cfgPath }),
      /* @__PURE__ */ u$1(Button, { variant: "primary", onClick: () => void save(), disabled: busy || !dirty, children: "保存" })
    ] }),
    /* @__PURE__ */ u$1("fieldset", { class: "fieldset", children: [
      /* @__PURE__ */ u$1("legend", { children: "判断引擎（硬要求，没有它扩展不启动）" }),
      /* @__PURE__ */ u$1(Field, { label: "API key", hint: draft.typesafe?.apiKeySet ? `已配置，长度 ${draft.typesafe.apiKeySet}；只写不读，留空就是不改` : "没配。环境变量 TYPESAFE_API_KEY 优先于这里", children: /* @__PURE__ */ u$1("input", { class: "input", type: "password", value: apiKey, placeholder: draft.typesafe?.apiKeySet ? "留空 = 不改" : "apikey_...", onInput: (e2) => setApiKey(e2.currentTarget.value), autocomplete: "off" }) }),
      /* @__PURE__ */ u$1("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: "10px" }, children: [
        /* @__PURE__ */ u$1(Field, { label: "端点 baseUrl", children: /* @__PURE__ */ u$1("input", { class: "input", value: draft.typesafe?.baseUrl ?? "", onInput: (e2) => patch((c2) => void (c2.typesafe = { ...c2.typesafe, baseUrl: e2.currentTarget.value })) }) }),
        /* @__PURE__ */ u$1(Field, { label: "模型", children: /* @__PURE__ */ u$1("input", { class: "input", value: draft.typesafe?.model ?? "", onInput: (e2) => patch((c2) => void (c2.typesafe = { ...c2.typesafe, model: e2.currentTarget.value })) }) }),
        /* @__PURE__ */ u$1(Field, { label: "交互超时 (ms)", hint: "召回路径宁可不注入也不拖住用户", children: /* @__PURE__ */ u$1("input", { class: "input mono", type: "number", value: draft.typesafe?.timeoutMs ?? "", onInput: (e2) => patch((c2) => void (c2.typesafe = { ...c2.typesafe, timeoutMs: Number(e2.currentTarget.value) || void 0 })) }) }),
        /* @__PURE__ */ u$1(Field, { label: "相关性阈值", children: /* @__PURE__ */ u$1("input", { class: "input mono", type: "number", step: "0.05", value: draft.judge?.relevanceThreshold ?? "", onInput: (e2) => patch((c2) => void (c2.judge = { ...c2.judge, relevanceThreshold: Number(e2.currentTarget.value) || void 0 })) }) }),
        /* @__PURE__ */ u$1(Field, { label: "代理 http", hint: "改完要重启 pi，并且启动前设 NODE_USE_ENV_PROXY=1", children: /* @__PURE__ */ u$1("input", { class: "input", value: draft.proxy?.http ?? "", onInput: (e2) => patch((c2) => void (c2.proxy = { ...c2.proxy, http: e2.currentTarget.value })) }) })
      ] })
    ] }),
    /* @__PURE__ */ u$1("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: "14px" }, children: [
      /* @__PURE__ */ u$1("fieldset", { class: "fieldset", children: [
        /* @__PURE__ */ u$1("legend", { children: "注入" }),
        /* @__PURE__ */ u$1(Field, { label: "每会话最多注入次数", children: /* @__PURE__ */ u$1("input", { class: "input mono", type: "number", value: draft.inject?.maxPerSession ?? "", onInput: (e2) => patch((c2) => void (c2.inject = { ...c2.inject, maxPerSession: Number(e2.currentTarget.value) || void 0 })) }) }),
        /* @__PURE__ */ u$1(Field, { label: "两次注入至少间隔几轮", children: /* @__PURE__ */ u$1("input", { class: "input mono", type: "number", value: draft.inject?.minTurnsBetween ?? "", onInput: (e2) => patch((c2) => void (c2.inject = { ...c2.inject, minTurnsBetween: Number(e2.currentTarget.value) || void 0 })) }) })
      ] }),
      /* @__PURE__ */ u$1("fieldset", { class: "fieldset", children: [
        /* @__PURE__ */ u$1("legend", { children: "召回" }),
        /* @__PURE__ */ u$1(Field, { label: "每路候选上限", children: /* @__PURE__ */ u$1("input", { class: "input mono", type: "number", value: draft.recall?.perSourceLimit ?? "", onInput: (e2) => patch((c2) => void (c2.recall = { ...c2.recall, perSourceLimit: Number(e2.currentTarget.value) || void 0 })) }) }),
        Object.keys(draft.recall?.weights ?? { relevance: 0, vector: 0, topic: 0, importance: 0, recency: 0 }).map((k2) => /* @__PURE__ */ u$1(Field, { label: `权重 ${k2}`, children: /* @__PURE__ */ u$1(
          "input",
          {
            class: "input mono",
            type: "number",
            step: "0.05",
            value: draft.recall?.weights?.[k2] ?? "",
            onInput: (e2) => patch((c2) => {
              c2.recall = { ...c2.recall, weights: { ...c2.recall?.weights ?? {}, [k2]: Number(e2.currentTarget.value) || 0 } };
            })
          }
        ) }, k2))
      ] }),
      /* @__PURE__ */ u$1("fieldset", { class: "fieldset", children: [
        /* @__PURE__ */ u$1("legend", { children: "生命周期与主动提醒" }),
        /* @__PURE__ */ u$1(Field, { label: "session 记忆自动清理（不可逆）", hint: "默认关。打开后按天数销毁 session 记忆，找不回来", children: /* @__PURE__ */ u$1("select", { class: "select", value: String(draft.lifecycle?.autoCleanup ?? false), onChange: (e2) => patch((c2) => void (c2.lifecycle = { ...c2.lifecycle, autoCleanup: e2.currentTarget.value === "true" })), children: [
          /* @__PURE__ */ u$1("option", { value: "false", children: "关闭" }),
          /* @__PURE__ */ u$1("option", { value: "true", children: "打开" })
        ] }) }),
        /* @__PURE__ */ u$1(Field, { label: "session 保留天数", children: /* @__PURE__ */ u$1("input", { class: "input mono", type: "number", value: draft.lifecycle?.sessionTtlDays ?? "", onInput: (e2) => patch((c2) => void (c2.lifecycle = { ...c2.lifecycle, sessionTtlDays: Number(e2.currentTarget.value) || void 0 })) }) }),
        /* @__PURE__ */ u$1(Field, { label: "主动提醒", children: /* @__PURE__ */ u$1("select", { class: "select", value: String(draft.proactive?.enabled ?? true), onChange: (e2) => patch((c2) => void (c2.proactive = { ...c2.proactive, enabled: e2.currentTarget.value === "true" })), children: [
          /* @__PURE__ */ u$1("option", { value: "true", children: "开" }),
          /* @__PURE__ */ u$1("option", { value: "false", children: "关" })
        ] }) }),
        /* @__PURE__ */ u$1(Field, { label: "每会话最多提醒次数", children: /* @__PURE__ */ u$1("input", { class: "input mono", type: "number", value: draft.proactive?.maxPerSession ?? "", onInput: (e2) => patch((c2) => void (c2.proactive = { ...c2.proactive, maxPerSession: Number(e2.currentTarget.value) || void 0 })) }) })
      ] }),
      /* @__PURE__ */ u$1("fieldset", { class: "fieldset", children: [
        /* @__PURE__ */ u$1("legend", { children: "面板与账号" }),
        /* @__PURE__ */ u$1(Field, { label: "面板端口", hint: "0 = 系统挑。改完重启 pi 生效", children: /* @__PURE__ */ u$1("input", { class: "input mono", type: "number", value: draft.ui?.port ?? 0, onInput: (e2) => patch((c2) => void (c2.ui = { port: Number(e2.currentTarget.value) || 0 })) }) }),
        /* @__PURE__ */ u$1(AccountForm, { user })
      ] })
    ] })
  ] });
}
function AccountForm({ user }) {
  const [current, setCurrent] = d("");
  const [name, setName] = d(user);
  const [password, setPassword] = d("");
  const [busy, setBusy] = d(false);
  return /* @__PURE__ */ u$1("div", { children: [
    /* @__PURE__ */ u$1(Field, { label: "当前密码", children: /* @__PURE__ */ u$1("input", { class: "input", type: "password", value: current, onInput: (e2) => setCurrent(e2.currentTarget.value), autocomplete: "current-password" }) }),
    /* @__PURE__ */ u$1(Field, { label: "账号名", children: /* @__PURE__ */ u$1("input", { class: "input", value: name, onInput: (e2) => setName(e2.currentTarget.value) }) }),
    /* @__PURE__ */ u$1(Field, { label: "新密码", hint: "至少 8 位；改完要重新登录", children: /* @__PURE__ */ u$1("input", { class: "input", type: "password", value: password, onInput: (e2) => setPassword(e2.currentTarget.value), autocomplete: "new-password" }) }),
    /* @__PURE__ */ u$1(
      Button,
      {
        disabled: busy || !current || password.length < 8,
        onClick: async () => {
          setBusy(true);
          try {
            await api.account({ current, username: name, password });
            toast("账号已更新，请重新登录");
            setCurrent("");
            setPassword("");
          } catch (e2) {
            toast(e2.message, "bad");
          } finally {
            setBusy(false);
          }
        },
        children: "改账号密码"
      }
    )
  ] });
}
function Inspector({ scope, id, version, onClose, onChanged }) {
  const { data, error, loading, reload } = useAsync(() => api.detail(scope, id), [scope, id, version]);
  const [confirmDelete, setConfirmDelete] = d(false);
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制");
    } catch {
      toast("复制失败，手动选吧", "bad");
    }
  };
  const remove = async () => {
    try {
      await api.remove(scope, id);
      toast("已删除（不可逆）");
      setConfirmDelete(false);
      onChanged();
      onClose();
    } catch (e2) {
      toast(e2.message, "bad");
    }
  };
  const m2 = data?.memory;
  const paths = data?.paths ?? [];
  const traces = data?.traces ?? [];
  return /* @__PURE__ */ u$1("aside", { class: "inspector", "aria-label": "记忆详情", children: [
    /* @__PURE__ */ u$1("header", { class: "inspector-head", children: [
      /* @__PURE__ */ u$1("span", { class: "mono faint", children: shortId(id) }),
      m2 ? /* @__PURE__ */ u$1(StateChip, { state: m2.state }) : null,
      /* @__PURE__ */ u$1("span", { class: "spacer" }),
      /* @__PURE__ */ u$1(Button, { variant: "ghost", size: "sm", icon: "copy", title: "复制 id", onClick: () => void copy(id) }),
      /* @__PURE__ */ u$1(Button, { variant: "ghost", size: "sm", icon: "close", title: "关闭（Esc）", onClick: onClose })
    ] }),
    loading && !data ? /* @__PURE__ */ u$1(Skeleton, { rows: 6 }) : error ? /* @__PURE__ */ u$1(ErrorNote, { error, onRetry: reload }) : !m2 ? null : /* @__PURE__ */ u$1(S, { children: [
      /* @__PURE__ */ u$1("div", { class: "inspector-body", children: [
        /* @__PURE__ */ u$1("div", { children: [
          /* @__PURE__ */ u$1("div", { class: "content-large wrap", children: m2.content }),
          m2.summary ? /* @__PURE__ */ u$1("div", { class: "dim", style: { marginTop: "6px" }, children: m2.summary }) : null
        ] }),
        /* @__PURE__ */ u$1("dl", { class: "meta-grid", children: [
          /* @__PURE__ */ u$1("dt", { children: "类型" }),
          /* @__PURE__ */ u$1("dd", { children: [
            /* @__PURE__ */ u$1(TypeChip, { type: m2.type }),
            " ",
            /* @__PURE__ */ u$1(Chip, { children: SCOPE_LABEL[m2.scope] ?? m2.scope }),
            " ",
            m2.scopeId ? /* @__PURE__ */ u$1("span", { class: "mono faint", children: m2.scopeId }) : null
          ] }),
          /* @__PURE__ */ u$1("dt", { children: "主题" }),
          /* @__PURE__ */ u$1("dd", { children: m2.topic ?? /* @__PURE__ */ u$1("span", { class: "dim", children: "没起主题" }) }),
          /* @__PURE__ */ u$1("dt", { children: "重要度" }),
          /* @__PURE__ */ u$1("dd", { class: "mono", children: [
            fixed(m2.importance, 2),
            " ",
            /* @__PURE__ */ u$1("span", { class: "faint", children: [
              "· 衰减 ",
              fixed(m2.decayScore, 2)
            ] })
          ] }),
          /* @__PURE__ */ u$1("dt", { children: "访问" }),
          /* @__PURE__ */ u$1("dd", { class: "mono", children: [
            m2.accessCount,
            " 次 ",
            /* @__PURE__ */ u$1("span", { class: "faint", children: [
              "· 上次 ",
              ago(m2.lastAccessed)
            ] })
          ] }),
          /* @__PURE__ */ u$1("dt", { children: "写入" }),
          /* @__PURE__ */ u$1("dd", { class: "mono", title: stamp(m2.createdAt), children: ago(m2.createdAt) }),
          /* @__PURE__ */ u$1("dt", { children: "来源" }),
          /* @__PURE__ */ u$1("dd", { class: "mono truncate", title: m2.source ?? "", children: m2.source ? `会话 ${shortId(m2.source)}` : "-" }),
          paths.length > 0 ? /* @__PURE__ */ u$1(S, { children: [
            /* @__PURE__ */ u$1("dt", { children: "代码路径" }),
            /* @__PURE__ */ u$1("dd", { children: paths.map((p2) => /* @__PURE__ */ u$1("div", { class: "mono", children: p2 }, p2)) })
          ] }) : null
        ] }),
        /* @__PURE__ */ u$1("div", { children: [
          /* @__PURE__ */ u$1("h3", { style: { margin: "0 0 8px", fontSize: "12px", color: "var(--fg-dim)", fontWeight: 500 }, children: "为什么记住" }),
          /* @__PURE__ */ u$1(Timeline, { items: traces })
        ] })
      ] }),
      /* @__PURE__ */ u$1("div", { class: "inspector-foot", children: [
        /* @__PURE__ */ u$1(Button, { variant: "danger", icon: "trash", onClick: () => setConfirmDelete(true), children: "删除" }),
        /* @__PURE__ */ u$1("span", { class: "spacer" }),
        /* @__PURE__ */ u$1(Button, { variant: "ghost", icon: "refresh", onClick: reload, children: "刷新" })
      ] }),
      confirmDelete ? /* @__PURE__ */ u$1(
        Dialog,
        {
          title: "删除这条记忆？",
          onClose: () => setConfirmDelete(false),
          actions: /* @__PURE__ */ u$1(S, { children: [
            /* @__PURE__ */ u$1(Button, { variant: "ghost", onClick: () => setConfirmDelete(false), children: "取消" }),
            /* @__PURE__ */ u$1(Button, { variant: "primary", onClick: () => void remove(), children: "确认删除" })
          ] }),
          children: [
            "硬删除，删了找不回来（轨迹里会留一条 J12 delete 记录）。",
            /* @__PURE__ */ u$1("div", { class: "quote", children: m2.content })
          ]
        }
      ) : null
    ] })
  ] });
}
const VIEWS = [
  { id: "overview", label: "概览", icon: "overview", key: "1" },
  { id: "graph", label: "图谱", icon: "graph", key: "2" },
  { id: "memories", label: "记忆", icon: "list", key: "3" },
  { id: "pending", label: "待确认", icon: "review", key: "4" },
  { id: "dupes", label: "近义堆", icon: "stack", key: "5" },
  { id: "settings", label: "设置", icon: "settings", key: "6" }
];
const fromHash = () => {
  const h2 = location.hash.replace(/^#\/?/, "");
  return VIEWS.find((v2) => v2.id === h2)?.id ?? "graph";
};
function useTheme() {
  const [theme, setTheme] = d(() => {
    const stored = localStorage.getItem("rs-theme");
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  h(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("rs-theme", theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t2) => t2 === "dark" ? "light" : "dark") };
}
function App({ user }) {
  const { theme, toggle } = useTheme();
  const [view, setView] = d(fromHash);
  const [scope, setScope] = d("project");
  const [query, setQuery] = d("");
  const [selected, setSelected] = d(null);
  const [graphFocus, setGraphFocus] = d(null);
  const [version, setVersion] = d(0);
  const [paletteOpen, setPaletteOpen] = d(false);
  const [helpOpen, setHelpOpen] = d(false);
  const [railCollapsed, setRailCollapsed] = d(false);
  const [summary, setSummary] = d(null);
  const pendingG = A(null);
  const bump = q(() => setVersion((v2) => v2 + 1), []);
  h(() => {
    const onHash = () => setView(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = q((id) => {
    location.hash = `#/${id}`;
    setView(id);
  }, []);
  h(() => {
    api.overview(scope).then(
      (o2) => setSummary({
        count: o2.project.count,
        pending: o2.pending,
        dupes: o2.dupes,
        engine: o2.engine.ready ? o2.engine.model ?? "已配置" : "不可用",
        engineBad: !o2.engine.ready || o2.engine.problems.length > 0,
        dbFile: o2.project.file,
        topics: o2.topics
      })
    ).catch(() => setSummary(null));
  }, [scope, view, version]);
  h(() => {
    const onKey = (e2) => {
      const t2 = e2.target;
      const typing = !!t2 && (/input|textarea|select/i.test(t2.tagName) || t2.isContentEditable);
      if ((e2.metaKey || e2.ctrlKey) && e2.key.toLowerCase() === "k") {
        e2.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (typing) return;
      if (pendingG.current === "g") {
        pendingG.current = null;
        const hit = VIEWS.find((v2) => v2.key === e2.key);
        if (hit) {
          e2.preventDefault();
          go(hit.id);
          return;
        }
      }
      if (e2.key === "g") {
        pendingG.current = "g";
        setTimeout(() => pendingG.current = null, 900);
        return;
      }
      if (e2.key === "/") {
        e2.preventDefault();
        go("memories");
        setTimeout(() => document.querySelector(".main input[type=search]")?.focus(), 30);
        return;
      }
      if (e2.key === "?") {
        setHelpOpen(true);
        return;
      }
      if (e2.key === "Escape" && !paletteOpen) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, paletteOpen]);
  const openMemory = q((id) => setSelected(id), []);
  return /* @__PURE__ */ u$1("div", { class: `shell ${railCollapsed ? "rail-collapsed" : ""}`, children: [
    /* @__PURE__ */ u$1("header", { class: "topbar", children: [
      /* @__PURE__ */ u$1("span", { class: "brand", children: [
        /* @__PURE__ */ u$1(Icon, { name: "stack", size: 16 }),
        /* @__PURE__ */ u$1("span", { children: "反思存储" })
      ] }),
      /* @__PURE__ */ u$1("select", { class: "select", value: scope, onChange: (e2) => {
        setScope(e2.currentTarget.value);
        setSelected(null);
        setGraphFocus(null);
      }, "aria-label": "库", children: [
        /* @__PURE__ */ u$1("option", { value: "project", children: "项目库" }),
        /* @__PURE__ */ u$1("option", { value: "global", children: "全局库" })
      ] }),
      /* @__PURE__ */ u$1("span", { class: "dbpath truncate", title: summary?.dbFile ?? "", children: summary?.dbFile ?? "" }),
      /* @__PURE__ */ u$1("span", { class: "spacer" }),
      /* @__PURE__ */ u$1("button", { class: "cmdk", type: "button", onClick: () => setPaletteOpen(true), children: [
        /* @__PURE__ */ u$1(Icon, { name: "search", size: 14 }),
        /* @__PURE__ */ u$1("span", { children: "搜索记忆 / 跳转" }),
        /* @__PURE__ */ u$1("span", { class: "spacer" }),
        /* @__PURE__ */ u$1("kbd", { children: "⌘K" })
      ] }),
      /* @__PURE__ */ u$1("span", { class: "spacer" }),
      /* @__PURE__ */ u$1("span", { class: "topright", children: [
        summary?.engineBad ? /* @__PURE__ */ u$1(Chip, { tone: "warn", title: "判断引擎有问题，设置页能看详情", children: summary.engine }) : /* @__PURE__ */ u$1(Chip, { tone: "accent", title: "判断引擎正常", children: summary?.engine ?? "-" }),
        /* @__PURE__ */ u$1(Button, { variant: "ghost", size: "sm", icon: theme === "dark" ? "sun" : "moon", title: "切换明暗", onClick: toggle }),
        /* @__PURE__ */ u$1("span", { class: "dim mono", title: "当前账号", children: user }),
        /* @__PURE__ */ u$1("form", { method: "post", action: "/api/logout", style: { display: "inline" }, children: /* @__PURE__ */ u$1(Button, { variant: "ghost", size: "sm", type: "submit", children: "退出" }) })
      ] })
    ] }),
    /* @__PURE__ */ u$1("nav", { class: "rail", "aria-label": "主导航", children: [
      /* @__PURE__ */ u$1("div", { style: { padding: "8px 6px 0" }, children: /* @__PURE__ */ u$1("nav", { children: VIEWS.map((v2) => /* @__PURE__ */ u$1("button", { class: "navitem", "aria-current": view === v2.id ? "page" : void 0, onClick: () => go(v2.id), title: `${v2.label}（g ${v2.key}）`, children: [
        /* @__PURE__ */ u$1(Icon, { name: v2.icon }),
        /* @__PURE__ */ u$1("span", { class: "label", children: v2.label }),
        v2.id === "memories" && summary ? /* @__PURE__ */ u$1("span", { class: "n", children: summary.count }) : null,
        v2.id === "pending" && summary?.pending ? /* @__PURE__ */ u$1("span", { class: "n", style: { color: "var(--warn)" }, children: summary.pending }) : null,
        v2.id === "dupes" && summary?.dupes ? /* @__PURE__ */ u$1("span", { class: "n", children: summary.dupes }) : null
      ] }, v2.id)) }) }),
      /* @__PURE__ */ u$1("div", { class: "rail-section", children: "主题" }),
      /* @__PURE__ */ u$1("div", { class: "rail-topics", children: (summary?.topics ?? []).length === 0 ? /* @__PURE__ */ u$1("div", { class: "dim", style: { padding: "4px 8px", fontSize: "12px" }, children: "还没有主题。复核队列里给记忆起个名字就有了。" }) : (summary?.topics ?? []).map((t2) => /* @__PURE__ */ u$1(
        "button",
        {
          class: "navitem",
          onClick: () => {
            setQuery(t2);
            go("memories");
          },
          children: [
            /* @__PURE__ */ u$1(Icon, { name: "chevron", size: 12 }),
            /* @__PURE__ */ u$1("span", { class: "label truncate", children: t2 })
          ]
        },
        t2
      )) }),
      /* @__PURE__ */ u$1("button", { class: "railtoggle", type: "button", onClick: () => setRailCollapsed((v2) => !v2), title: "折叠左栏", children: [
        /* @__PURE__ */ u$1(Icon, { name: railCollapsed ? "chevron" : "close", size: 14 }),
        /* @__PURE__ */ u$1("span", { class: "label", children: "折叠" })
      ] })
    ] }),
    /* @__PURE__ */ u$1("main", { class: "main", children: [
      view === "overview" ? /* @__PURE__ */ u$1(OverviewView, { scope, version }) : null,
      view === "graph" ? /* @__PURE__ */ u$1(GraphSection, { scope, version, selected, onSelect: setSelected, focus: graphFocus, onFocus: setGraphFocus, onOpen: openMemory }) : null,
      view === "memories" ? /* @__PURE__ */ u$1(MemoriesView, { scope, version, query, onQuery: setQuery, selected, onSelect: setSelected }) : null,
      view === "pending" ? /* @__PURE__ */ u$1(PendingView, { scope, version, onChanged: bump, onOpenMemory: openMemory }) : null,
      view === "dupes" ? /* @__PURE__ */ u$1(DupesView, { scope, version, onOpenMemory: openMemory, onChanged: bump }) : null,
      view === "settings" ? /* @__PURE__ */ u$1(SettingsView, { user, onSaved: bump }) : null
    ] }),
    selected ? /* @__PURE__ */ u$1(Inspector, { scope, id: selected, version, onClose: () => setSelected(null), onChanged: bump }) : null,
    paletteOpen ? /* @__PURE__ */ u$1(
      Palette,
      {
        scope,
        onClose: () => setPaletteOpen(false),
        onPickView: (v2) => {
          go(v2);
          setPaletteOpen(false);
        },
        onPickMemory: (id) => {
          setSelected(id);
          setGraphFocus(id);
          go("graph");
          setPaletteOpen(false);
        }
      }
    ) : null,
    helpOpen ? /* @__PURE__ */ u$1(Dialog, { title: "快捷键", onClose: () => setHelpOpen(false), actions: /* @__PURE__ */ u$1(Button, { onClick: () => setHelpOpen(false), children: "知道了" }), children: /* @__PURE__ */ u$1("dl", { class: "meta-grid", children: [
      /* @__PURE__ */ u$1("dt", { children: /* @__PURE__ */ u$1(KeyHint, { keys: ["⌘K"] }) }),
      /* @__PURE__ */ u$1("dd", { children: "命令面板：搜记忆、跳视图" }),
      /* @__PURE__ */ u$1("dt", { children: /* @__PURE__ */ u$1(KeyHint, { keys: ["g", "1-6"] }) }),
      /* @__PURE__ */ u$1("dd", { children: "切视图（概览 / 图谱 / 记忆 / 待确认 / 近义堆 / 设置）" }),
      /* @__PURE__ */ u$1("dt", { children: /* @__PURE__ */ u$1(KeyHint, { keys: ["/"] }) }),
      /* @__PURE__ */ u$1("dd", { children: "跳到记忆列表并聚焦搜索" }),
      /* @__PURE__ */ u$1("dt", { children: /* @__PURE__ */ u$1(KeyHint, { keys: ["J", "K"] }) }),
      /* @__PURE__ */ u$1("dd", { children: "列表里上下移动，选中即打开右侧详情" }),
      /* @__PURE__ */ u$1("dt", { children: /* @__PURE__ */ u$1(KeyHint, { keys: ["1-9"] }) }),
      /* @__PURE__ */ u$1("dd", { children: "待确认视图里直接选第 n 个选项" }),
      /* @__PURE__ */ u$1("dt", { children: /* @__PURE__ */ u$1(KeyHint, { keys: ["方向键"] }) }),
      /* @__PURE__ */ u$1("dd", { children: [
        "图谱里按方向挑节点，",
        /* @__PURE__ */ u$1(KeyHint, { keys: ["Shift"] }),
        " + 方向 = 换焦点"
      ] }),
      /* @__PURE__ */ u$1("dt", { children: /* @__PURE__ */ u$1(KeyHint, { keys: ["F"] }) }),
      /* @__PURE__ */ u$1("dd", { children: "图谱适配窗口" }),
      /* @__PURE__ */ u$1("dt", { children: /* @__PURE__ */ u$1(KeyHint, { keys: ["Esc"] }) }),
      /* @__PURE__ */ u$1("dd", { children: "关详情；图谱里先回到全库概览" })
    ] }) }) : null,
    /* @__PURE__ */ u$1(ToastHost, {})
  ] });
}
function GraphSection(props) {
  const [data, setData] = d(null);
  const [error, setError] = d(null);
  h(() => {
    let alive = true;
    api.graph(props.scope).then((d2) => alive && (setData(d2), setError(null))).catch((e2) => alive && setError(e2));
    return () => {
      alive = false;
    };
  }, [props.scope, props.version]);
  return /* @__PURE__ */ u$1("div", { class: "view", children: [
    /* @__PURE__ */ u$1("div", { class: "view-head", children: [
      /* @__PURE__ */ u$1("h1", { children: "图谱" }),
      /* @__PURE__ */ u$1("span", { class: "sub dim", children: data ? `${data.nodes.length} 个节点 · ${data.links.length} 条关系` : "加载中" })
    ] }),
    error ? /* @__PURE__ */ u$1("div", { class: "panel", children: /* @__PURE__ */ u$1("div", { class: "empty", children: [
      /* @__PURE__ */ u$1("h3", { children: "读不到图谱数据" }),
      /* @__PURE__ */ u$1("p", { class: "mono", children: error.message })
    ] }) }) : data ? /* @__PURE__ */ u$1(Graph, { data, selected: props.selected, onSelect: props.onSelect, focus: props.focus, onFocus: props.onFocus, onOpen: props.onOpen }) : /* @__PURE__ */ u$1("div", { class: "graph", children: /* @__PURE__ */ u$1("div", { class: "skeleton", style: { height: "100%", margin: "12px" } }) })
  ] });
}
function Palette({ scope, onClose, onPickView, onPickMemory }) {
  const [q2, setQ] = d("");
  const [items, setItems] = d([]);
  const [idx, setIdx] = d(0);
  const inputRef = A(null);
  h(() => {
    api.memories(scope).then((r2) => setItems(r2.items)).catch(() => toast("读不到记忆列表", "bad"));
  }, [scope]);
  const views = VIEWS.filter((v2) => !q2 || v2.label.includes(q2) || v2.id.includes(q2));
  const memories = T(() => {
    const needle = q2.trim().toLowerCase();
    const list = needle ? items.filter((m2) => m2.content.toLowerCase().includes(needle) || m2.id.startsWith(needle)) : items.slice(0, 8);
    return list.slice(0, 20);
  }, [items, q2]);
  const rows = [
    ...views.map((v2) => ({ key: `v-${v2.id}`, label: v2.label, hint: `视图 · g ${v2.key}`, run: () => onPickView(v2.id) })),
    ...memories.map((m2) => ({
      key: `m-${m2.id}`,
      label: m2.content.slice(0, 80),
      hint: `${TYPE_LABEL[m2.type] ?? m2.type} · ${shortId(m2.id)}`,
      run: () => onPickMemory(m2.id)
    }))
  ];
  h(() => {
    inputRef.current?.focus();
  }, []);
  h(() => setIdx(0), [q2]);
  const onKey = (e2) => {
    if (e2.key === "Escape") {
      e2.preventDefault();
      onClose();
      return;
    }
    if (e2.key === "ArrowDown") {
      e2.preventDefault();
      setIdx((i2) => Math.min(rows.length - 1, i2 + 1));
    }
    if (e2.key === "ArrowUp") {
      e2.preventDefault();
      setIdx((i2) => Math.max(0, i2 - 1));
    }
    if (e2.key === "Enter") {
      e2.preventDefault();
      rows[idx]?.run();
    }
  };
  return /* @__PURE__ */ u$1("div", { class: "overlay", onClick: (e2) => e2.target === e2.currentTarget && onClose(), children: /* @__PURE__ */ u$1("div", { class: "palette", role: "dialog", "aria-modal": "true", "aria-label": "命令面板", children: [
    /* @__PURE__ */ u$1("input", { ref: inputRef, value: q2, placeholder: `搜索记忆（${SCOPE_LABEL[scope] ?? scope}）/ 跳视图…`, onInput: (e2) => setQ(e2.currentTarget.value), onKeyDown: onKey }),
    /* @__PURE__ */ u$1("div", { class: "palette-list", children: [
      rows.length === 0 ? /* @__PURE__ */ u$1("div", { class: "dim", style: { padding: "10px" }, children: "没有匹配项。" }) : null,
      rows.map((r2, i2) => /* @__PURE__ */ u$1("button", { class: "palette-item", "aria-selected": i2 === idx, onMouseEnter: () => setIdx(i2), onClick: r2.run, children: [
        /* @__PURE__ */ u$1("span", { class: "truncate", children: r2.label }),
        /* @__PURE__ */ u$1("span", { class: "kind", children: r2.hint })
      ] }, r2.key))
    ] })
  ] }) });
}
function Boot() {
  const [user, setUser] = d(null);
  h(() => {
    api.session().then((s2) => setUser(s2.user)).catch(() => setUser(""));
  }, []);
  if (user === null) return null;
  return /* @__PURE__ */ u$1(App, { user });
}
R(/* @__PURE__ */ u$1(Boot, {}), document.getElementById("root"));
