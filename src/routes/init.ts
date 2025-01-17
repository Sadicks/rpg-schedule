import express from "express";
import request from "request";
import moment from "moment";
import { Client } from "discord.js";
import merge from "lodash/merge";

import { Game } from "../models/game";
import { GuildConfig } from "../models/guild-config";
import config from "../models/config";
import aux from "../appaux";
import db from "../db";

const connection = db.connection;

export default (options: any) => {
  const router = express.Router();
  const client: Client = options.client;

  router.use("/", async (req: any, res, next) => {
    const supportedLanguages = require("../../lang/langs.json");
    const selectedLang = req.cookies.lang && supportedLanguages.langs.includes(req.cookies.lang) ? req.cookies.lang : "en";
    const languages = supportedLanguages.langs
      .map((lang: String) => {
        return {
          code: lang,
          ...require(`../../lang/${lang}.json`),
          selected: lang === selectedLang
        };
      })
      .sort((a: any, b: any) => (a.name > b.name ? 1 : -1));

    req.lang = {
      // if a property that exists in the english version doesn't exist in another language, use the english version
      selected: merge(languages.find((lang: any) => lang.code === "en"), languages.find((lang: any) => lang.selected)),
      list: languages.map((lang: any) => ({ code: lang.code, name: lang.name, selected: lang.selected }))
    };

    res.locals.lang = req.lang.selected;
    res.locals.langs = req.lang.list;
    res.locals.url = req._parsedOriginalUrl.pathname;

    const parsedURLs = aux.parseConfigURLs(config.urls);
    if (!parsedURLs.find(path => path.session && req._parsedOriginalUrl.pathname === path.url)) {
      next();
      return;
    }

    const guildPermission = parsedURLs.find(path => path.guildPermission && req._parsedOriginalUrl.pathname === path.url) ? true : false;

    req.account = {
      viewing: {
        home: res.locals.url === config.urls.base.url,
        games: res.locals.url === config.urls.game.games.url,
        dashboard: res.locals.url === config.urls.game.dashboard.url,
        game: res.locals.url === config.urls.game.create.url
      },
      guilds: [],
      user: null
    };

    res.locals.account = req.account;

    try {
      const storedSession = await connection()
        .collection("sessions")
        .findOne({ _id: req.session.id });
      if (storedSession) {
        req.session.status = storedSession.session.status;
      }

      if (req.session.status) {
        const access = req.session.status.access;
        if (access.token_type) {
          request(
            {
              url: "https://discordapp.com/api/users/@me",
              method: "GET",
              headers: {
                authorization: `${access.token_type} ${access.access_token}`
              }
            },
            async (error, response, body) => {
              try {
                if (!error && response.statusCode === 200) {
                  const response = JSON.parse(body);
                  const { username, discriminator, id, avatar } = response;
                  const tag = `${username}#${discriminator}`;
                  const guildConfigs = await GuildConfig.fetchAll();
                  req.account.user = {
                    ...response,
                    ...{
                      tag: tag,
                      avatarURL: `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=128`
                    }
                  };

                  client.guilds.forEach(guild => {
                    const guildConfig = guildConfigs.find(gc => gc.guild === guild.id) || new GuildConfig({ guild: guild.id });
                    guild.members.forEach(member => {
                      if (member.id === id) {
                        req.account.guilds.push({
                          id: guild.id,
                          name: guild.name,
                          icon: guild.iconURL,
                          permission: guildConfig.role
                            ? member.roles.find(r => r.name.toLowerCase().trim() === guildConfig.role.toLowerCase().trim())
                            : true,
                          channels: guild.channels,
                          config: guildConfig,
                          games: []
                        });
                      }
                    });
                  });

                  if (guildPermission) {
                    req.account.guilds = req.account.guilds.filter(
                      guild => !guild.config.hidden // && (req.account.viewing.games || req.account.viewing.dashboard))
                    );
                  }

                  const gameOptions: any = {
                    s: {
                      $in: req.account.guilds.reduce((i, g) => {
                        i.push(g.id);
                        return i;
                      }, [])
                    }
                  };

                  if (req.account.viewing.dashboard && tag !== config.author) {
                    gameOptions.$or = [
                      {
                        dm: tag
                      },
                      {
                        reserved: {
                          $regex: tag.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")
                        }
                      }
                    ];
                  }

                  if (req.account.viewing.games) {
                    gameOptions.timestamp = {
                      $gt: new Date().getTime()
                    };
                    gameOptions.dm = {
                      $ne: tag
                    };
                  }

                  const games: any[] = await Game.fetchAllBy(gameOptions);
                  games.forEach(game => {
                    if (!game.discordGuild) return;

                    const date = Game.ISOGameDate(game);
                    game.moment = {
                      raw: `${game.date} ${game.time} GMT${game.timezone < 0 ? "-" : "+"}${Math.abs(game.timezone)}`,
                      iso: date,
                      date: moment(date)
                        .utcOffset(parseInt(game.timezone))
                        .format(config.formats.dateLong),
                      calendar: moment(date)
                        .utcOffset(parseInt(game.timezone))
                        .calendar(),
                      from: moment(date)
                        .utcOffset(parseInt(game.timezone))
                        .fromNow()
                    };

                    game.slot = game.reserved.split(/\r?\n/).findIndex(t => t.trim().replace("@", "") === tag) + 1;
                    game.signedup = game.slot > 0 && game.slot <= parseInt(game.players);
                    game.waitlisted = game.slot > parseInt(game.players);

                    const gi = req.account.guilds.findIndex(g => g.id === game.s);
                    req.account.guilds[gi].games.push(game);
                  });

                  if (req.account.viewing.games) {
                    req.account.guilds = req.account.guilds.filter(guild => guild.games.length > 0);
                  }

                  req.account.guilds = req.account.guilds.map(guild => {
                    guild.games.sort((a, b) => {
                      return a.timestamp < b.timestamp ? -1 : 1;
                    });
                    return guild;
                  });

                  req.account.guilds.sort((a, b) => {
                    if (a.games.length === 0 && b.games.length === 0) return a.name < b.name ? -1 : 1;
                    if (a.games.length === 0) return 1;
                    if (b.games.length === 0) return -1;

                    return a.games[0].timestamp < b.games[0].timestamp ? -1 : 1;
                  });

                  if (req.account.viewing.home) {
                    res.redirect(config.urls.game.dashboard.url);
                    return;
                  }

                  next();
                  return;
                }
                throw new Error(error);
              } catch (err) {
                if (req.account.viewing.dashboard) {
                  res.render("error", { message: "init.ts:1:<br />" + err });
                } else {
                  next();
                }
              }
            }
          );
        } else {
          if (req.account.viewing.home) next();
          else res.redirect(config.urls.login.url + "?redirect=" + escape(req.originalUrl));
        }
      } else {
        if (req.account.viewing.home) next();
        else res.redirect(config.urls.login.url + "?redirect=" + escape(req.originalUrl));
      }
    } catch (e) {
      res.render("error", { message: "init.ts:2:<br />" + e.message });
    }
  });

  router.use(config.urls.changeLang.url, (req, res, next) => {
    res.cookie("lang", req.params.newLang).redirect(req.query.returnTo);
  });

  return router;
};
