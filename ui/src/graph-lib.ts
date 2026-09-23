/**
 * 图谱库单独一个 chunk。
 *
 * Cytoscape + fcose 加起来比整个面板的其余部分还大，而这个视图不是每次打开面板都要看 ——
 * 所以走**动态 import**：概览/列表/设置这些视图不为它买单，只有点进图谱才加载。
 * 注册布局扩展放在这里，保证只跑一次（use() 是全局注册）。
 */
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";

cytoscape.use(fcose);

export default cytoscape;
