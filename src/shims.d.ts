/**
 * 本地构建 shim：@deepseek-ai/* 未发布公共 npm（由 profile pnpm 闭包在运行时注入），
 * 这里只声明本插件用到的最小类型面，保证 out-of-tree `tsc` 可编译。
 * 注意：若在已安装真实 @deepseek-ai/* 包的环境编译，请删除本文件改用真实类型。
 */
declare module '@deepseek-ai/dsh-tools' {
  export interface ContentBlock {
    type: string
    text: string
  }
  export interface ToolDefinition {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: Record<string, unknown>
      render?: (args: unknown, value: unknown) => ContentBlock[]
    }
    execute: (args: Record<string, unknown>) => Promise<string> | string
    timeoutMs?: number
  }
  export function defineTool(def: ToolDefinition): ToolDefinition
}

declare module '@deepseek-ai/cordis' {
  export interface Context {
    tools: {
      register(def: unknown): () => void
    }
  }
}
