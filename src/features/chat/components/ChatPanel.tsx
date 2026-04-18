import { Thread } from "@/global/components/assistant-ui/thread";
import { ThreadList } from "@/global/components/assistant-ui/thread-list";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/global/components/ui/resizable";

export default function ChatPanel() {
  return (
    <ResizablePanelGroup orientation="vertical">
      <ResizablePanel defaultSize="10%" className="p-4 overflow-hidden">
        <ThreadList />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel className="relative">
        <div className="flex flex-col h-full">
          <div className="flex-1 min-h-0">
            <Thread />
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
