import type { ReadinessComponent } from "~/domain/readiness";

/**
 * The one banner for a shop that has not pressed Finish setup, shared by Home
 * and the settings hub so they cannot say two different things.
 *
 * It states the one fact that matters — nothing synchronizes until setup is
 * finished — and then each part of setup in a single line, ticked or not, so
 * what is left is readable at a glance instead of from a sentence. A part the
 * merchant switched off says "off", which is an answer, not a gap.
 *
 * Nothing here decides anything: readiness is `domain/readiness`, and
 * `activated` is `shop.setup_completed_at` (docs/ui-conventions.md § Setup
 * state). The caller renders this only while `activated` is false.
 */
export function SetupBanner({
  components,
  overall,
}: {
  components: ReadinessComponent[];
  overall: "ready" | "needs_attention";
}) {
  // Products is optional and never part of setup.
  const steps = components.filter(
    (component) => component.status !== "optional",
  );
  const ready = overall === "ready";

  return (
    <s-banner tone={ready ? "info" : "warning"} heading="Finish setup">
      <s-stack direction="block" gap="small-300">
        <s-paragraph>
          {ready
            ? "Everything required is answered. Synchronization starts when you finish setup."
            : "Synchronization won't start until setup is completed. Whatever you have answered is saved."}
        </s-paragraph>
        <s-stack direction="inline" gap="small-100 base" alignItems="center">
          {steps.map((step) => (
            <SetupStep key={step.key} step={step} />
          ))}
        </s-stack>
      </s-stack>
      {/* A banner's only action slot; "primary-action" is a page's, and in a banner it renders as body text. */}
      <s-button slot="secondary-actions" href="/app/setup">
        {ready ? "Finish setup" : "Continue setup"}
      </s-button>
    </s-banner>
  );
}

function SetupStep({ step }: { step: ReadinessComponent }) {
  const missing = step.status === "needs_attention" && step.required;
  const state =
    step.status === "disabled"
      ? "off"
      : step.status === "needs_attention"
        ? "needs an answer"
        : "done";

  return (
    <s-stack direction="inline" gap="small-500" alignItems="center">
      {step.status === "disabled" ? null : (
        <s-icon
          type={step.status === "needs_attention" ? "alert-circle" : "check"}
          tone={
            missing
              ? "critical"
              : step.status === "needs_attention"
                ? "caution"
                : "auto"
          }
          color={step.status === "needs_attention" ? "base" : "subdued"}
          size="small"
        />
      )}
      <s-text type={missing ? "strong" : "generic"}>{step.title}</s-text>
      {step.status === "disabled" ? (
        <s-text color="subdued">off</s-text>
      ) : (
        <s-text accessibilityVisibility="exclusive">{`, ${state}`}</s-text>
      )}
    </s-stack>
  );
}
