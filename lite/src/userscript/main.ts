import { bootstrapHackerNewsReader } from "../app/bootstrap";

if (location.hostname === "news.ycombinator.com") {
  bootstrapHackerNewsReader();
}
