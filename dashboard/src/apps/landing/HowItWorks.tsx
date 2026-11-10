import type { ReactElement } from "react";
import { useCursorLight } from "./use-cursor-light";
import { useScrollReveal } from "./use-scroll-reveal";

/**
 * The "How it works" section: one request travelling end to end, drawn as a
 * rail of eight equal cells — client, the six gateway stages, the provider
 * account — with a packet that walks out along it and stops at the provider.
 *
 * Equal cells are what make the motion cheap to write: cell *k* sits at
 * `k/7` of the track that runs between the first and last cell centre, so one
 * `translateX` keyframe positions the packet exactly on every node. The trail
 * is a static child that hangs off the same moving wrapper and is clipped by
 * the track, so the lit line behind the packet costs no animation of its own.
 *
 * Every event that means "the packet got here" is an `animation-delay` on its
 * own 8 s cycle rather than a separate keyframe — node pings, the status
 * readout, and the packet stay in step because they all start on page load and
 * share a period, not because any of them knows about the others. The account
 * rotation runs on 24 s (three request cycles) so each account serves one.
 *
 * All of the timing lives in `landing.css` beside the keyframes it drives;
 * this component owns structure only.
 */

interface FlowStage {
  readonly index: string;
  readonly name: string;
  readonly detail: string;
}

const STAGES: readonly FlowStage[] = [
  { index: "01", name: "ingress", detail: "Body read once." },
  { index: "02", name: "pipeline", detail: "Identity, abuse, auth, parse." },
  { index: "03", name: "plan", detail: "Alias, combo, capability." },
  { index: "04", name: "leases", detail: "Admission, slot, reservation." },
  { index: "05", name: "dispatch", detail: "Stream primed before 200." },
  { index: "06", name: "settle", detail: "Usage, health, telemetry." },
];

/**
 * The readout under the rail. One line per 0.8 s hop, listed in order so
 * `nth-child` can delay each to the moment the packet reaches its cell. The
 * cycle is 8 s, so ten lines at one hop apart cover it without a hole — the
 * last two describe the request resting, not travelling, because the packet
 * does not walk back: it finishes at the provider and the next cycle starts
 * from the client again.
 */
const NOTES: readonly string[] = [
  "client · POST /v1/messages",
  "ingress · body read once",
  "pipeline · identity, abuse, auth, parse",
  "plan · alias, combo, capability",
  "leases · admission, slot, reservation",
  "dispatch · stream primed before 200",
  "settle · usage, health, telemetry",
  "account · request delivered",
  "settled · usage recorded",
  "ready for the next request",
];

const ACCOUNTS: readonly string[] = ["openai", "anthropic", "gemini"];

function Node(): ReactElement {
  return (
    <span className="lr-flow-node" aria-hidden={true}>
      <i className="lr-flow-node-ping" />
      <i className="lr-flow-node-core" />
    </span>
  );
}

export function HowItWorks(): ReactElement {
  const reveal = useScrollReveal<HTMLDivElement>();
  const light = useCursorLight<HTMLDivElement>();

  return (
    <section className="lr-section" id="how">
      <div className="lr-shell">
        <p className="lr-eyebrow">How it works</p>
        <h2 className="lr-heading">One request, end to end.</h2>
        <p className="lr-sub">
          A client posts to one URL. LianRouter folds the body into a canonical
          request, walks it through six stages, and hands it to a provider
          account that can actually serve it. Watch it cross the rail.
        </p>

        <div className="lr-reveal" ref={reveal.ref}>
          <div className="lr-card lr-howcard" ref={light.ref}>
            <div className="lr-flow">
              <div className="lr-flow-railwrap">
                {/* A light that rides with the packet, so the cell it is
                    crossing looks lit from inside rather than merely
                    neighbouring a moving dot. It sits before the rail in the
                    DOM, which puts it under the labels: the pool washes the
                    cell ground, the text stays crisp on top. */}
                <span className="lr-flow-poolclip" aria-hidden="true">
                  <span className="lr-flow-pool">
                    <i className="lr-flow-pool-light" />
                  </span>
                </span>

                <ol className="lr-flow-rail">
                  <li className="lr-flow-cell lr-flow-end lr-flow-client">
                    <span className="lr-flow-end-label">Client</span>
                    <Node />
                    <span className="lr-flow-cell-body">
                      <span className="lr-flow-method">POST</span>
                      <span className="lr-flow-path">/v1/messages</span>
                      <span className="lr-flow-hint">Claude Code · Codex · Cursor</span>
                    </span>
                  </li>

                  {STAGES.map((stage) => (
                    <li className="lr-flow-cell lr-flow-stage" key={stage.index}>
                      <Node />
                      <span className="lr-flow-index">{stage.index}</span>
                      <span className="lr-flow-cell-body">
                        <span className="lr-flow-name">{stage.name}</span>
                        <span className="lr-flow-detail">{stage.detail}</span>
                      </span>
                    </li>
                  ))}

                  <li className="lr-flow-cell lr-flow-end lr-flow-provider">
                    <span className="lr-flow-end-label">Provider</span>
                    <Node />
                    <span className="lr-flow-cell-body lr-flow-accounts">
                      {ACCOUNTS.map((account) => (
                        <span className="lr-flow-account" key={account}>
                          {account}
                        </span>
                      ))}
                    </span>
                  </li>
                </ol>

                {/* The wire, the lit trail, and the packet. Purely decorative:
                    every cell already carries the stage it belongs to as
                    text, so nothing here needs to reach an assistive reader. */}
                <div className="lr-flow-track" aria-hidden={true}>
                  <span className="lr-flow-wire" />
                  <span className="lr-flow-clip">
                    <span className="lr-flow-mover">
                      <span className="lr-flow-trail" />
                    </span>
                  </span>
                  <span className="lr-flow-packet">
                    <i className="lr-flow-dot" />
                  </span>
                </div>
              </div>

              <div className="lr-flow-status" aria-hidden={true}>
                {NOTES.map((note) => (
                  <span className="lr-flow-note" key={note}>
                    {note}
                  </span>
                ))}
              </div>

              <div className="lr-card-meta">
                <span>canonical request in · one wire format out</span>
                <span className="lr-card-status">Every surface, same path</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
