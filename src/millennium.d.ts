declare module 'millennium' {
  export function definePlugin(factory: () => {
    title: string;
    icon?: unknown;
    content: unknown;
  }): unknown;
}
