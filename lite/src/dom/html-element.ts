export function htmlElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tagName: K,
  className = "",
  textContent?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}
