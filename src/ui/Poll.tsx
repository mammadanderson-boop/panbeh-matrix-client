import { t } from "../i18n.ts";
import { useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { M_POLL_END, M_POLL_KIND_DISCLOSED, M_POLL_KIND_UNDISCLOSED, M_POLL_RESPONSE, M_POLL_START, PollEvent, type MatrixEvent, type Poll, type Room } from "matrix-js-sdk";
import { PollStartEvent } from "matrix-js-sdk/lib/extensible_events_v1/PollStartEvent.js";
import { PollResponseEvent } from "matrix-js-sdk/lib/extensible_events_v1/PollResponseEvent.js";
import { PollEndEvent } from "matrix-js-sdk/lib/extensible_events_v1/PollEndEvent.js";
import { client } from "../matrix.ts";
import { usePromise, useTick } from "../hooks.ts";
import { num, tallyPoll } from "../logic.ts";
import { Icon } from "../icons.tsx";
import { errText, me, parsePoll, Sheet } from "./common.tsx";
import { alertDialog, confirmDialog } from "./dialog.tsx";

const MAX_ANSWERS = 20;
// ponytail: Matrix has no anonymous polls; votes stay signed events, so this only asks clients (ours) not to show names
const ANONYMOUS = "ir.panbeh.poll.anonymous";

// Poll.getResponses() resolves to undefined if a fetch is already running (e.g. the row remounted while scrolling),
// so every PollBody for a poll shares the first call's promise
const responses = new WeakMap<Poll, ReturnType<Poll["getResponses"]>>();
const responsesOf = (poll: Poll) => {
  if (!responses.has(poll)) {
    const p = poll.getResponses();
    p.catch(() => responses.delete(poll)); // retry on next render
    responses.set(poll, p);
  }
  return responses.get(poll)!;
};

/** New poll, or (edit) a replacement for one nobody has voted on yet. Sent with the unstable types, which every client reads. */
export function PollForm({ room, threadId, edit, onClose }: { room: Room; threadId: string | null; edit?: MatrixEvent; onClose: () => void }) {
  const old = edit ? parsePoll(edit) : null;
  const [question, setQuestion] = useState(old?.question.text ?? "");
  const [answers, setAnswers] = useState(old ? old.answers.map((a) => a.text) : ["", ""]);
  const [multi, setMulti] = useState((old?.maxSelections ?? 1) > 1);
  const [hidden, setHidden] = useState(!!old && M_POLL_KIND_UNDISCLOSED.matches(old.rawKind));
  const [anonymous, setAnonymous] = useState(!!edit?.getContent()[ANONYMOUS]);
  const [busy, setBusy] = useState(false);
  const opts = answers.map((a) => a.trim()).filter(Boolean);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const kind = (hidden ? M_POLL_KIND_UNDISCLOSED : M_POLL_KIND_DISCLOSED).name;
    const content = { ...PollStartEvent.from(question.trim(), opts, kind, multi ? opts.length : 1).serialize().content, ...(anonymous && { [ANONYMOUS]: true }) };
    try {
      if (edit) await client.sendEvent(room.roomId, M_POLL_START.name as never, {
        ...content, "m.new_content": content, "m.relates_to": { rel_type: "m.replace", event_id: edit.getId()! },
      } as never);
      else await client.sendEvent(room.roomId, threadId, M_POLL_START.name as never, content as never);
      onClose();
    } catch (err) {
      alertDialog(errText(err));
      setBusy(false);
    }
  }

  const setAnswer = (i: number, v: string) => setAnswers((a) => a.map((x, j) => (j === i ? v : x)));
  return (
    <Sheet title={edit ? t("poll.editTitle") : t("poll.new")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t("poll.question")} aria-label={t("poll.question")} dir="auto" required autoFocus />
        <h3>{t("poll.options")}</h3>
        {answers.map((a, i) => (
          <div key={i} className="poll-edit-opt">
            <input value={a} onChange={(e) => setAnswer(i, e.target.value)} placeholder={t("poll.option", { n: i + 1 })} aria-label={t("poll.option", { n: i + 1 })} dir="auto" />
            {answers.length > 2 && (
              <button type="button" className="icon-btn" aria-label={t("poll.removeOption")} onClick={() => setAnswers((x) => x.filter((_, j) => j !== i))}><Icon name="close" size={18} /></button>
            )}
          </div>
        ))}
        {answers.length < MAX_ANSWERS && (
          <div className="row-actions"><button type="button" onClick={() => setAnswers((a) => [...a, ""])}><Icon name="plus" /> {t("poll.addOption")}</button></div>
        )}
        <label className="switch-row"><span>{t("poll.multi")}<small>{t("poll.multiHint")}</small></span>
          <input type="checkbox" role="switch" checked={multi} onChange={(e) => setMulti(e.target.checked)} /></label>
        <label className="switch-row"><span>{t("poll.hidden")}<small>{t("poll.hiddenHint")}</small></span>
          <input type="checkbox" role="switch" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /></label>
        <label className="switch-row"><span>{t("poll.anon")}<small>{t("poll.anonHint")}</small></span>
          <input type="checkbox" role="switch" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /></label>
        <button className="primary" disabled={busy || !question.trim() || opts.length < 2}>{edit ? t("common.save") : t("poll.send")}</button>
      </form>
    </Sheet>
  );
}

export function PollBody({ ev, room }: { ev: MatrixEvent; room: Room }) {
  useTick(room, [PollEvent.New]); // the SDK builds the Poll after (decrypting) the start event
  const poll = room.polls.get(ev.getId()!);
  useTick(poll, [PollEvent.Responses, PollEvent.End, PollEvent.Update]);
  const rels = usePromise(useMemo(() => (poll ? responsesOf(poll) : null), [poll]));
  const [pending, setPending] = useState<{ answers: string[]; at: number } | null>(null);
  const [editing, setEditing] = useState(false);

  const p = parsePoll(ev);
  if (!p) return <p className="msg-text muted">{t("poll.invalid")}</p>;
  const ids = p.answers.map((a) => a.id);
  const max = Math.max(1, p.maxSelections);
  const votes = (rels?.getRelations() ?? []).map((r) => {
    const c = r.getContent();
    return { sender: r.getSender()!, ts: r.getTs(), answers: (c[M_POLL_RESPONSE.name] ?? c[M_POLL_RESPONSE.altName])?.answers };
  });
  const { voters, picks } = tallyPoll(votes, ids, max);
  // my vote shows right away; the server's copy takes over once any new response arrives
  const mine = pending && pending.at === votes.length ? pending.answers : picks.get(me()) ?? [];
  const ended = !!poll?.isEnded;
  const undisclosed = M_POLL_KIND_UNDISCLOSED.matches(p.rawKind);
  const anonymous = !!ev.getContent()[ANONYMOUS];
  const results = ended || (!undisclosed && mine.length > 0);
  const total = picks.size;
  const top = Math.max(...ids.map((id) => voters.get(id)!.length));
  const name = (id: string) => room.getMember(id)?.name ?? id;

  function vote(id: string) {
    if (ended || !poll) return;
    const next = max === 1 ? [id] : mine.includes(id) ? mine.filter((x) => x !== id) : [...mine, id].slice(-max);
    if (max === 1 && mine[0] === id) return;
    setPending({ answers: next, at: votes.length });
    // empty selection = a spoiled vote, which is how a multi-choice voter takes their vote back
    client.sendEvent(room.roomId, M_POLL_RESPONSE.name as never, PollResponseEvent.from(next, poll.pollId).serialize().content as never)
      .catch((e) => { setPending(null); alertDialog(errText(e)); });
  }

  const canEnd = !!poll && !ended && (ev.getSender() === me() || room.currentState.maySendRedactionForEvent(ev, me()));
  const canEdit = !!rels && !ended && total === 0 && votes.length === 0 && ev.getSender() === me();
  const end = async () => {
    if (!(await confirmDialog(t("poll.endQ")))) return;
    client.sendEvent(room.roomId, M_POLL_END.name as never, PollEndEvent.from(poll!.pollId, "The poll has ended").serialize().content as never)
      .catch((e) => alertDialog(errText(e)));
  };

  return (
    // the bubble toggles its action bar on click; voting shouldn't
    <div className="poll" onClick={(e) => e.stopPropagation()}>
      <b className="poll-q" dir="auto">{p.question.text}</b>
      <small className="poll-kind">
        {ended ? t("poll.ended") : [undisclosed ? t("poll.hidden") : t("poll.poll"), anonymous && t("poll.anon"), max > 1 && t("poll.multi")].filter(Boolean).join(" · ")}
      </small>
      {p.answers.map((a) => {
        const who = voters.get(a.id)!;
        const pct = total ? Math.round((who.length / total) * 100) : 0;
        const on = mine.includes(a.id);
        return (
          <button key={a.id} className={"poll-opt" + (on ? " on" : "") + (ended && who.length && who.length === top ? " win" : "")}
            disabled={ended || !poll} onClick={() => vote(a.id)} title={results && !anonymous && who.length ? who.map(name).join(t("list.sep")) : undefined}>
            <span className={"poll-mark" + (max > 1 ? " square" : "")}>{on && <Icon name="check" size={13} />}</span>
            <span className="poll-text" dir="auto">{a.text}</span>
            {results && <span className="poll-pct">{t("poll.pct", { n: pct })}</span>}
            {results && <span className="poll-bar" style={{ width: pct + "%" }} />}
          </button>
        );
      })}
      <div className="poll-foot">
        <span>{total ? t("poll.votes", { count: total }) : t("poll.noVotes")}</span>
        {canEdit && <button onClick={() => setEditing(true)}>{t("msg.edit")}</button>}
        {canEnd && <button onClick={end}>{t("poll.end")}</button>}
      </div>
      {/* portal: a fixed sheet inside the virtualized bubble would be clipped and catch its clicks */}
      {editing && createPortal(<PollForm room={room} threadId={null} edit={ev} onClose={() => setEditing(false)} />, document.body)}
    </div>
  );
}
