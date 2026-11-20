import { createRoot } from "react-dom/client";
import { PullFiles } from "../../src/bundled/github/PullFiles";
import type { GitHubDiff } from "../../src/bundled/github/gh";
import "../../src/shared/styles/globals.css";

// A coherent PR-sized change; each prefix is the unified-diff status of a
// source line. Count the hunk rather than hand-maintaining its header.
const lines = [
  " package example.feed",
  " ",
  " import kotlinx.coroutines.flow.Flow",
  " import kotlinx.coroutines.flow.map",
  " ",
  " /** A feed entry whose payload belongs to the caller. */",
  " @JvmInline",
  " value class ArticleId(val value: String)",
  " ",
  " data class Article<T : Any>(",
  "   val id: ArticleId,",
  "   val title: String,",
  "   val payload: T,",
  "   val score: Double? = null,",
  " )",
  " ",
  " interface ArticleSource<T : Any> {",
  "   fun observe(limit: Int): Flow<List<Article<T>>>",
  " }",
  " ",
  " sealed interface FeedState<out T : Any> {",
  "   data object Loading : FeedState<Nothing>",
  "   data class Ready<T : Any>(",
  "     val items: List<Article<T>>,",
  "     val summary: String,",
  "   ) : FeedState<T>",
  "   data class Failed(val reason: String) : FeedState<Nothing>",
  " }",
  " ",
  " class FeedPresenter<T : Any>(",
  "   private val source: ArticleSource<T>,",
  " ) {",
  "-  suspend fun load(limit: Int): Flow<FeedState<T>> =",
  "-    source.observe(limit).map { articles ->",
  '-      FeedState.Ready(articles, "Hello")',
  "-    }",
  "-  // Show every article while the feed is small.",
  "+  suspend fun load(limit: Int): Flow<FeedState<T>> =",
  "+    source.observe(limit.coerceIn(1, 50)).map { articles ->",
  "+      // Only strong matches belong in the summary.",
  "+      val selected = articles.filter { (it.score ?: 0.0) >= 0.75 }",
  "+      val preview: Article<T>? = selected.firstOrNull()",
  '+      val summary = """',
  `+        Found \${selected.size} matching articles`,
  `+        Top story: \${preview?.title ?: "none"}`,
  '+      """.trimIndent()',
  "+      when {",
  '+        selected.isEmpty() -> FeedState.Failed("No matches")',
  "+        else -> FeedState.Ready(selected.sortedByScore(), summary)",
  "+      }",
  "+    }",
  " ",
  "   private fun List<Article<T>>.sortedByScore(): List<Article<T>> =",
  "     sortedByDescending { it.score ?: 0.0 }",
  " }",
];
const oldCount = lines.filter((line) => !line.startsWith("+")).length;
const newCount = lines.filter((line) => !line.startsWith("-")).length;
const patch = [
  "diff --git a/src/FeedPresenter.kt b/src/FeedPresenter.kt",
  "index 1234567..abcdef0 100644",
  "--- a/src/FeedPresenter.kt",
  "+++ b/src/FeedPresenter.kt",
  `@@ -5100,${oldCount} +5100,${newCount} @@`,
  ...lines,
  "",
].join("\n");
const calls: Parameters<GitHubDiff>[0][] = [];
(window as unknown as { diffCalls: typeof calls }).diffCalls = calls;
const diff: GitHubDiff = async (pull) => {
  calls.push(pull);
  return patch;
};
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <aside aria-label="GitHub changes" style={{ maxWidth: "980px" }}>
    <PullFiles
      url="https://github.com/example-org/sample/pull/1"
      pull={{ repository: "example-org/sample", base: "base", head: "head" }}
      diff={diff}
    />
  </aside>,
);
