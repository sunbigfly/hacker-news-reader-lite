/** Finds the HN story list across both legacy and current list-page markup. */
export function findHnListTable(root: ParentNode): HTMLTableElement | null {
  return root.querySelector<HTMLTableElement>("table.itemlist")
    ?? root.querySelector("tr.athing[id]")?.closest<HTMLTableElement>("table")
    ?? null;
}

export function findHnMoreLink(root: ParentNode): HTMLAnchorElement | null {
  return findHnListTable(root)?.querySelector<HTMLAnchorElement>("a.morelink") ?? null;
}
