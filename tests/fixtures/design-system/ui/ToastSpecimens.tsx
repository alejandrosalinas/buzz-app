import { ToastPlayground } from "./ToastPlayground";
import { ExamplePreview } from "./ExamplePreview";
import { useRef, useState } from "react";
import {
  ToastNotice,
  ToastProvider,
} from "../../../../src/shared/design-system/ui/Toast";
import { Dialog } from "../../../../src/shared/design-system/ui/Dialog";
import { Button } from "../../../../src/shared/design-system/ui/Button";

export function ToastSpecimens() {
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [linked, setLinked] = useState(false);
  const [recoveries, setRecoveries] = useState<number[]>([]);
  const [modal, setModal] = useState(false);
  const modalTrigger = useRef<HTMLButtonElement>(null);
  return (
    <ExamplePreview
      label="Notifications"
      code={`<ToastProvider>
  <div className="flex max-w-sm flex-wrap gap-3">
    <Button onClick={() => setSaved(true)}>Show confirmation</Button>
    <Button onClick={() => setFailed(true)}>Show recovery</Button>
    <Button onClick={() => setLinked(true)}>Show linked notice</Button>
    <Button onClick={() => setRecoveries([1, 2, 3, 4, 5, 6])}>
      Show recovery stack
    </Button>
    <Button ref={modalTrigger} onClick={() => setModal(true)}>
      Open example dialog
    </Button>
  </div>
  {saved && (
    <ToastNotice
      title="Changes saved"
      tone="success"
      timeout={5000}
      onDismiss={() => setSaved(false)}
    />
  )}
  {linked && (
    <ToastNotice title="Plugin update available" description="Save your drafts before you update."
      navigation={{label:"Open related dialog",open:()=>{setLinked(false);setModal(true);}}}>
      <Button onClick={()=>setLinked(false)}>Update</Button>
    </ToastNotice>
  )}
  {failed && (
    <ToastNotice
      title="Changes weren’t saved"
      description="Your choices still apply for this session. Retry to save them on this device."
    >
      <Button size="sm" onClick={() => setFailed(false)}>
        Retry saving
      </Button>
    </ToastNotice>
  )}
  {recoveries.map((id) => (
    <ToastNotice
      key={id}
      title={\`Recovery \${id}\`}
      description="This action remains available until its source resolves."
    >
      <Button
        size="sm"
        onClick={() =>
          setRecoveries((current) => current.filter((item) => item !== id))
        }
      >
        Resolve {id}
      </Button>
    </ToastNotice>
  ))}
  <Dialog
    open={modal}
    onOpenChange={setModal}
    title="Example dialog"
    finalFocus={modalTrigger}
  >
    Recovery notifications wait behind the modal without interrupting its
    controls.
  </Dialog>
</ToastProvider>`}
    >
      {(visible) =>
        visible && (
          <ToastProvider>
            <div className="min-w-0 w-full">
              <div className="flex max-w-sm flex-wrap gap-3">
                <Button onClick={() => setSaved(true)}>
                  Show confirmation
                </Button>
                <Button onClick={() => setFailed(true)}>Show recovery</Button>
                <Button onClick={() => setLinked(true)}>
                  Show linked notice
                </Button>
                <Button onClick={() => setRecoveries([1, 2, 3, 4, 5, 6])}>
                  Show recovery stack
                </Button>
                <Button ref={modalTrigger} onClick={() => setModal(true)}>
                  Open example dialog
                </Button>
              </div>
              <ToastPlayground />
              {saved && (
                <ToastNotice
                  title="Changes saved"
                  tone="success"
                  timeout={5000}
                  onDismiss={() => setSaved(false)}
                />
              )}
              {linked && (
                <ToastNotice
                  title="Plugin update available"
                  description="Save your drafts before you update."
                  navigation={{
                    label: "Open related dialog",
                    open: () => {
                      setLinked(false);
                      setModal(true);
                    },
                  }}
                >
                  <Button onClick={() => setLinked(false)}>Update</Button>
                </ToastNotice>
              )}
              {failed && (
                <ToastNotice
                  title="Changes weren’t saved"
                  description="Your choices still apply for this session. Retry to save them on this device."
                >
                  <Button size="sm" onClick={() => setFailed(false)}>
                    Retry saving
                  </Button>
                </ToastNotice>
              )}
              {recoveries.map((id) => (
                <ToastNotice
                  key={id}
                  title={`Recovery ${id}`}
                  description="This action remains available until its source resolves."
                >
                  <Button
                    size="sm"
                    onClick={() =>
                      setRecoveries((current) =>
                        current.filter((item) => item !== id),
                      )
                    }
                  >
                    Resolve {id}
                  </Button>
                </ToastNotice>
              ))}
              <Dialog
                open={modal}
                onOpenChange={setModal}
                title="Example dialog"
                finalFocus={modalTrigger}
              >
                Recovery notifications wait behind the modal without
                interrupting its controls.
              </Dialog>
            </div>
          </ToastProvider>
        )
      }
    </ExamplePreview>
  );
}
