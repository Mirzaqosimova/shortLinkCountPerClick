// Install dependencies: express, pg, knex, cors, dotenv, @types/express
// Run: npm install express pg knex cors dotenv @types/express
import express, { Request, Response } from "express";
import knex from "knex";
import cors from "cors";
import dotenv from "dotenv";
import { nanoid } from "nanoid";
import { Status } from "./const";
import axios from "axios";
import cookieParser from "cookie-parser";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());
app.use(cookieParser());

// Initialize Knex
const db = knex({
  client: "pg",
  connection: process.env.DATABASE_URL,
});

// Create table if not exists
(async () => {
  const exists = await db.schema.hasTable("links");
  if (!exists) {
    await db.schema.createTable("links", (table) => {
      table.increments("id").primary();
      table.string("original_url").notNullable();
      table.string("short_id").notNullable();
      table.string("status").defaultTo(Status.ACTIVE);
      table.integer("clicks").defaultTo(0);
    });
    await db.schema.createTable("link_visitors", (table) => {
      table
        .integer("link_id")
        .references("id")
        .inTable("links")
        .index()
        .onDelete("CASCADE")
        .notNullable();
      table.string("ip_address").notNullable();
      table.string("user_id").notNullable();
    });
    console.log("Table 'links' created");
  }
})();

app.use((req, res, next) => {
  let userId = req.cookies?.user_id;
  if (!userId) {
    userId = nanoid(8); // Generate a unique identifier
    res.cookie("user_id", userId, { maxAge: 31536000000, httpOnly: true }); // Store for 1 year
  }
  req.body["userId"] = userId;
  next();
});

// API to create a new short link
app.post("/api/create", async (req: Request, res: Response): Promise<void> => {
  try {
    const apikey = req.headers.apikey;
    if (apikey !== "cb13341b-662b-46f5-9a94-1f691e51d134") {
      res.status(403).json({ error: "Token is invalid" });
      return;
    }

    const { original_url, short_id } = req.body;
    if (!original_url) {
      res.status(400).json({ error: "URL is required" });
      return;
    }
    if (short_id) {
      await db("links").where({ short_id }).del();
    }

    const new_short_id = nanoid(12);

    await db("links").insert({ short_id: new_short_id, original_url });

    res.json({
      short_id: new_short_id,
      url: `${req.protocol}://${req.get("host")}/${short_id}`,
    });
  } catch (error) {
    console.error("Error creating short link:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.put(
  "/api/change-status",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const apikey = req.headers.apikey;
      if (apikey !== "cb13341b-662b-46f5-9a94-1f691e51d134") {
        res.status(403).json({ error: "Token is invalid" });
        return;
      }

      const { status, short_id } = req.body;

      await db("links").where({ short_id }).update({ status });
      res.json({
        message: "Updated",
      });
    } catch (error) {
      console.error("Error creating short link:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

app.get(
  "/:short_id",
  async (req: Request<{ short_id: string }>, res: Response): Promise<void> => {
    try {
      const { short_id } = req.params;
      const userId = req.body.userId;
      const ip_address =
        req.headers["x-forwarded-for"] || req.socket.remoteAddress;

      console.log(userId, ip_address);
      const link = await db("links")
        .where({ short_id, status: Status.ACTIVE })
        .first();

      if (!userId) {
        res.status(404).json({ error: "Oops something went wrong" });
        return;
      }

      if (!link) {
        res.status(404).json({ error: "Link not found" });
        return;
      }
      const hasVisited = await db("link_visitors")
        .where({ link_id: link.id, user_id: userId })
        .first();

      if (hasVisited) {
        res.redirect(link.original_url);
        return;
      }

      await db.transaction(async (trx) => {
        return trx("link_visitors")
          .insert({
            user_id: userId,
            ip_address,
            link_id: link.id,
          })
          .then(async () => {
            return trx("links")
              .increment("clicks")
              .where({ id: link.id })
              .returning("id");
          });
      });

      try {
        await axios.put(
          `${process.env.CRM_URL}/links/update-count`,
          {
            short_id,
            count: link.clicks + 1,
          },
          {
            headers: {
              apikey: "cb13341b-662b-46f5-9a94-1f691e51d134",
            },
          }
        );
      } catch (externalError) {
        console.log(externalError);
        res.status(500).json({ error: "Internal server error" });
      }

      res.redirect(link.original_url);
    } catch (error) {
      console.error("Error handling redirect:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Get analytics
app.get("/api/stats", async (req: Request, res: Response) => {
  const links = await db("links").select();
  res.json(links);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
