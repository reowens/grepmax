import { describe, expect, it } from "vitest";
import { TreeSitterChunker } from "../src/lib/index/chunker";

describe.each(["ts", "tsx"])("decorated %s class chunking", (extension) => {
  it.each(["", "@Injectable()\n"])(
    "indexes methods and the class with class decorator %j",
    async (decorator) => {
      const source = `${decorator}export class UserService {
  constructor(@InjectRepository(User) private readonly repo: Repository<User>) {}
  async findAll(): Promise<User[]> {
    return this.repo.findAll();
  }
  async create(dto: CreateUserDto) {
    return this.repo.create(dto);
  }
}`;
      const offset = decorator ? 1 : 0;
      const { chunks, metadata } = await new TreeSitterChunker().chunk(
        `user.service.${extension}`,
        source,
      );

      expect(metadata.exports).toContain("UserService");
      const classChunk = chunks.find((chunk) => chunk.type === "class");
      expect(classChunk).toMatchObject({
        definedSymbols: ["UserService"],
        startLine: 0,
        endLine: 8 + offset,
        content: source,
        isExported: true,
      });
      expect(
        chunks
          .filter((chunk) => chunk.type === "method")
          .map((chunk) => ({
            symbols: chunk.definedSymbols,
            start: chunk.startLine,
            end: chunk.endLine,
            parent: chunk.parentSymbol,
          })),
      ).toEqual([
        {
          symbols: ["constructor"],
          start: 1 + offset,
          end: 1 + offset,
          parent: "UserService",
        },
        {
          symbols: ["findAll"],
          start: 2 + offset,
          end: 4 + offset,
          parent: "UserService",
        },
        {
          symbols: ["create"],
          start: 5 + offset,
          end: 7 + offset,
          parent: "UserService",
        },
      ]);
    },
  );

  it("includes sibling route decorators in method text and line ranges", async () => {
    const source = `@Controller('articles')
export class ArticleController {
  @Get(':slug')
  async findOne(@Param('slug') slug: string) {
    return this.articles.findOne(slug);
  }
  @Post(':slug/favorite')
  @UseGuards(AuthGuard)
  async favorite(@Param('slug') slug: string) {
    return this.articles.favorite(slug);
  }
  token() { return jwt.sign({}); }
}`;
    const { chunks } = await new TreeSitterChunker().chunk(
      `article.controller.${extension}`,
      source,
    );
    const methods = chunks.filter((chunk) => chunk.type === "method");
    expect(methods.map((chunk) => chunk.definedSymbols)).toEqual([
      ["findOne"],
      ["favorite"],
      ["token"],
    ]);
    for (const [name, start, end] of [
      ["findOne", 2, 5],
      ["favorite", 6, 10],
      ["token", 11, 11],
    ] as const) {
      const method = methods.find((chunk) =>
        chunk.definedSymbols?.includes(name),
      );
      expect(method).toMatchObject({
        startLine: start,
        endLine: end,
        parentSymbol: "ArticleController",
        content: source
          .split("\n")
          .slice(start, end + 1)
          .join("\n")
          .trimStart(),
      });
    }
    expect(methods[2].referencedSymbols).toContain("sign");
  });

  it("indexes an export default decorated class and its decorated method", async () => {
    const source = `@Injectable()
export default class TagService {
  @Trace()
  findAll() {
    return this.repo.findAll();
  }
}`;
    const { chunks, metadata } = await new TreeSitterChunker().chunk(
      `tag.service.${extension}`,
      source,
    );
    expect(metadata.exports).toContain("TagService");
    expect(chunks.find((chunk) => chunk.type === "class")).toMatchObject({
      definedSymbols: ["TagService"],
      startLine: 0,
      endLine: 6,
      content: source,
      isExported: true,
    });
    expect(chunks.find((chunk) => chunk.type === "method")).toMatchObject({
      definedSymbols: ["findAll"],
      startLine: 2,
      endLine: 5,
      parentSymbol: "TagService",
      content: source.split("\n").slice(2, 6).join("\n").trimStart(),
    });
  });
});
