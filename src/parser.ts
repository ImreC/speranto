import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";
import type { Root, Content } from "mdast";

export const parser = unified().use(remarkParse).use(remarkStringify);

export async function parseMarkdown(content: string): Promise<Root> {
  const tree = parser.parse(content);
  return tree as Root;
}

export async function stringifyMarkdown(tree: Root): Promise<string> {
  const result = parser.stringify(tree);
  return result;
}

export function getTranslatableNodes(
  tree: Root
): Array<{ node: Content; path: number[] }> {
  const nodes: Array<{ node: Content; path: number[] }> = [];

  visit(tree, (node, index, parent) => {
    if (!parent || index === null || index === undefined) return;

    // Collect text nodes and other translatable content
    if (
      node.type === "text" ||
      node.type === "heading" ||
      node.type === "paragraph" ||
      node.type === "blockquote" ||
      node.type === "listItem"
    ) {
      const path: number[] = [];
      let current = parent;
      let currentIndex: number = index;

      // Build path from root to this node
      while (current && current.type !== "root") {
        path.unshift(currentIndex);
        // This is simplified - in a real implementation we'd need to track the full path
        break;
      }

      nodes.push({ node: node as Content, path });
    }
  });

  return nodes;
}
