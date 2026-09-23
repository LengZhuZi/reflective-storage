import "./styles/tokens.css";
import "./styles/app.css";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./app";
import { api } from "./api";

/** 账号名只有服务端知道，启动时问一次；拿不到就退回空串（不影响功能）。 */
function Boot() {
  const [user, setUser] = useState<string | null>(null);
  useEffect(() => {
    api
      .session()
      .then((s) => setUser(s.user))
      .catch(() => setUser(""));
  }, []);
  if (user === null) return null;
  return <App user={user} />;
}

render(<Boot />, document.getElementById("root")!);
