import { Button } from "@/global/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/global/components/ui/dialog";
import useSettingsStore from "../stores/settings-store";
import { Switch } from "@/global/components/ui/switch";
import { Label } from "@/global/components/ui/label";

export default function SettingsModal() {
  const { isDarkMode, setDarkMode } = useSettingsStore();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Settings</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>uhh settings i guess</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <div className="grid flex-1 gap-2">
            <Switch
              id="dark-mode"
              checked={isDarkMode}
              onCheckedChange={(checked) => setDarkMode(checked)}
            />
            <Label htmlFor="dark-mode">Dark Mode</Label>
          </div>
        </div>
        <DialogFooter className="sm:justify-start">
          <DialogClose asChild>
            <Button type="button">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
