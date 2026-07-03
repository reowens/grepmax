import { describe, expect, it } from "vitest";
import { Skeletonizer } from "../src/lib/skeleton/skeletonizer";

async function skeletonize(source: string) {
  const skeletonizer = new Skeletonizer();
  await skeletonizer.init();
  return skeletonizer.skeletonizeFile("/tmp/query.ts", source);
}

describe("Skeletonizer SQL template hints", () => {
  it("summarizes SQL tagged templates hidden inside elided function bodies", async () => {
    const result = await skeletonize(`
      export async function loadUser(db: DB, id: string) {
        const rows = await db.query(sql\`
          SELECT users.id, teams.name
          FROM users
          JOIN teams ON teams.id = users.team_id
          WHERE users.id = \${id}
        \`);

        await db.query(sql.type(AuditRow)\`
          INSERT INTO audit_log (user_id, event)
          VALUES (\${id}, 'load')
        \`);

        return rows;
      }
    `);

    expect(result.success).toBe(true);
    expect(result.skeleton).toContain(
      "SQL: SELECT users, teams; INSERT audit_log",
    );
    expect(result.skeleton).not.toContain("WHERE users.id");
  });

  it("ignores non-SQL tagged templates", async () => {
    const result = await skeletonize(`
      export function render() {
        return html\`<div>SELECT * FROM users</div>\`;
      }
    `);

    expect(result.success).toBe(true);
    expect(result.skeleton).not.toContain("SQL:");
  });
});
