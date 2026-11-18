-- Local/offline prepared and never applied to production by this task.
CREATE TABLE controlled_preparations (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','complete','failed')),
 started_at INTEGER NOT NULL, finished_at INTEGER, saved INTEGER NOT NULL DEFAULT 0, reason TEXT
);
-- Reuse the existing publisher allowlist. Source approval is separate from feature activation.
INSERT OR IGNORE INTO controlled_sources(id,kind,host,feed_url,authorized,updated_at) VALUES
 ('news-mit','news','news.mit.edu','https://news.mit.edu/rss/research',1,0),
 ('news-science','news','www.sciencedaily.com','https://www.sciencedaily.com/rss/top/science.xml',1,0),
 ('news-health','news','www.sciencedaily.com','https://www.sciencedaily.com/rss/top/health.xml',1,0),
 ('news-tech','news','newatlas.com','https://newatlas.com/technology/index.rss',1,0),
 ('story-science','story','www.sciencedaily.com','https://www.sciencedaily.com/rss/top/science.xml',1,0),
 ('fact-mit','fact','news.mit.edu','https://news.mit.edu/rss/research',1,0);
