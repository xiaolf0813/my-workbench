import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function InstructionsViewer({
  name,
  instructions,
}: {
  name: string;
  instructions: string | null;
}) {
  const hasInstructions = Boolean(instructions?.trim());
  return (
    <section className="instructions" aria-label={`Role instructions: ${name}`}>
      <header>
        <h2>Agent prompt</h2>
      </header>
      <p className="warning">
        {hasInstructions
          ? "Full developer instructions from this agent's configuration file."
          : "No configuration-file role instructions are available for this agent."}
      </p>
      {hasInstructions ? (
        <div className="markdown-body">
          <Markdown remarkPlugins={[remarkGfm]}>{instructions}</Markdown>
        </div>
      ) : (
        <p className="empty">(not available)</p>
      )}
    </section>
  );
}
