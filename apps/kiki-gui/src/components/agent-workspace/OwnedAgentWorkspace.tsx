import { MediaPreviewProvider } from '../mediaPreview';
import { AgentWorkspace as WorkspaceContent, type AgentWorkspaceProps } from './AgentWorkspace';

export function AgentWorkspace(props: AgentWorkspaceProps) {
  return <WorkspaceContent {...props} mediaPreviewProvider={MediaPreviewProvider} />;
}
