import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  GuildMember,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { logger } from "../lib/logger";

const ROBLOX_GROUP_ID = 973049555;
const VERIFY_TIMEOUT_MS = 2 * 60 * 1000;
const SCAN_INTERVAL_MS = 2000;

interface PendingVerification {
  discordUserId: string;
  robloxUsername: string;
  code: string;
  interval: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingVerification>();

function generateCode(length = 8): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function getRobloxUserId(username: string): Promise<number | null> {
  try {
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    const data = (await res.json()) as { data: { id: number; name: string }[] };
    if (data.data && data.data.length > 0) return data.data[0].id;
    return null;
  } catch {
    return null;
  }
}

async function getRobloxDescription(userId: number): Promise<string | null> {
  try {
    const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
    const data = (await res.json()) as { description?: string };
    return data.description ?? null;
  } catch {
    return null;
  }
}

async function getRobloxGroupRank(
  userId: number,
  groupId: number
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://groups.roblox.com/v2/users/${userId}/groups/roles`
    );
    const data = (await res.json()) as {
      data: { group: { id: number }; role: { name: string } }[];
    };
    if (!data.data) {
      logger.warn({ userId, groupId, data }, "getRobloxGroupRank: no data field in response");
      return null;
    }
    const groupIds = data.data.map((g) => g.group.id);
    logger.info({ userId, groupId, groupIds }, "getRobloxGroupRank: user groups");
    const entry = data.data.find((g) => g.group.id === groupId);
    if (!entry) {
      logger.warn({ userId, groupId }, "getRobloxGroupRank: user not in group");
      return null;
    }
    logger.info({ userId, groupId, rank: entry.role.name }, "getRobloxGroupRank: found rank");
    return entry.role.name;
  } catch (err) {
    logger.error({ err, userId, groupId }, "getRobloxGroupRank: request failed");
    return null;
  }
}

function cancelVerification(userId: string) {
  const v = pending.get(userId);
  if (v) {
    clearInterval(v.interval);
    clearTimeout(v.timeout);
    pending.delete(userId);
  }
}

async function syncRobloxRole(member: GuildMember, rankName: string) {
  const guild = member.guild;
  logger.info({ rankName, guildId: guild.id }, "syncRobloxRole: attempting to sync");
  let role = guild.roles.cache.find(
    (r) => r.name.toLowerCase() === rankName.toLowerCase()
  );
  if (!role) {
    logger.info({ rankName }, "syncRobloxRole: role not found, creating it");
    try {
      role = await guild.roles.create({ name: rankName, reason: "Roblox group rank sync" });
      logger.info({ rankName, roleId: role.id }, "syncRobloxRole: created new role");
    } catch (err) {
      logger.error({ err, rankName }, "syncRobloxRole: failed to create role — bot may lack Manage Roles permission");
      return;
    }
  } else {
    logger.info({ rankName, roleId: role.id }, "syncRobloxRole: found existing role");
  }
  try {
    await member.roles.add(role, "Roblox verification rank sync");
    logger.info({ rankName, userId: member.id }, "syncRobloxRole: role assigned successfully");
  } catch (err) {
    logger.error({ err, rankName }, "syncRobloxRole: failed to assign role — bot role may be too low in hierarchy");
  }
}

async function giveVerifiedRole(member: GuildMember) {
  const guild = member.guild;
  let role = guild.roles.cache.find(
    (r) => r.name.toLowerCase() === "verified"
  );
  if (!role) {
    try {
      role = await guild.roles.create({
        name: "Verified",
        color: 0x57f287,
        reason: "Created by verification bot",
      });
    } catch (err) {
      logger.error({ err }, "Failed to create Verified role");
      return;
    }
  }
  try {
    await member.roles.add(role, "User completed Roblox verification");
  } catch (err) {
    logger.error({ err }, "Failed to assign Verified role");
  }
}

export function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN not set — Discord bot will not start");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.once("ready", async () => {
    logger.info({ tag: client.user?.tag }, "Discord bot logged in");

    const commands = [
      new SlashCommandBuilder()
        .setName("verify")
        .setDescription("Verify your Roblox account")
        .toJSON(),
    ];

    const rest = new REST({ version: "10" }).setToken(token);
    try {
      await rest.put(Routes.applicationCommands(client.user!.id), {
        body: commands,
      });
      logger.info("Slash commands registered globally");
    } catch (err) {
      logger.error({ err }, "Failed to register slash commands");
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === "verify") {
      await handleVerifyCommand(interaction as ChatInputCommandInteraction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === "verify_modal") {
      await handleVerifyModal(interaction as ModalSubmitInteraction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("cancel_verify_")) {
      const userId = interaction.customId.replace("cancel_verify_", "");
      if (userId === interaction.user.id) {
        cancelVerification(userId);
        await interaction.update({
          content: "Verification cancelled.",
          components: [],
        });
      }
    }
  });

  client.login(token).catch((err) => {
    logger.error({ err }, "Failed to log in to Discord");
  });
}

async function handleVerifyCommand(interaction: ChatInputCommandInteraction) {
  if (pending.has(interaction.user.id)) {
    await interaction.reply({
      content: "You already have a verification in progress. Check your DMs!",
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId("verify_modal")
    .setTitle("Roblox Verification");

  const usernameInput = new TextInputBuilder()
    .setCustomId("roblox_username")
    .setLabel("What is your Roblox username?")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("e.g. Builderman")
    .setRequired(true)
    .setMaxLength(20);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(usernameInput)
  );

  await interaction.showModal(modal);
}

async function handleVerifyModal(interaction: ModalSubmitInteraction) {
  if (pending.has(interaction.user.id)) {
    await interaction.reply({
      content: "You already have a verification in progress. Check your DMs!",
      ephemeral: true,
    });
    return;
  }

  const robloxUsername = interaction.fields.getTextInputValue("roblox_username").trim();
  const robloxId = await getRobloxUserId(robloxUsername);

  if (!robloxId) {
    await interaction.reply({
      content: `Could not find a Roblox user named **${robloxUsername}**. Please check the spelling and try again.`,
      ephemeral: true,
    });
    return;
  }

  const code = generateCode();

  const cancelButton = new ButtonBuilder()
    .setCustomId(`cancel_verify_${interaction.user.id}`)
    .setLabel("Cancel Verification")
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(cancelButton);

  const embed = new EmbedBuilder()
    .setTitle("Roblox Verification")
    .setColor(0x5865f2)
    .setDescription(
      `To verify ownership of **${robloxUsername}**, please:\n\n` +
      `1. Go to your Roblox profile: https://www.roblox.com/users/${robloxId}/profile\n` +
      `2. Edit your **About/Description** and paste the code from the message below\n` +
      `3. Save your profile — we'll detect it automatically\n\n` +
      `You have **2 minutes**. You can remove the code after verification.`
    )
    .setFooter({ text: "Scanning every 2 seconds..." });

  let dmChannel;
  let instructionMsg;
  try {
    dmChannel = await interaction.user.createDM();
    instructionMsg = await dmChannel.send({ embeds: [embed], components: [row] });
    await dmChannel.send(`**Copy your code:** \`${code}\``);
  } catch {
    await interaction.reply({
      content: "I couldn't DM you. Please enable DMs from server members and try again.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: "Check your DMs for verification instructions!",
    ephemeral: true,
  });

  const scanInterval = setInterval(async () => {
    const description = await getRobloxDescription(robloxId);
    if (description && description.includes(code)) {
      cancelVerification(interaction.user.id);

      let rankName: string | null = null;
      const member = interaction.guild?.members.cache.get(interaction.user.id)
        ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);

      if (member) {
        await giveVerifiedRole(member);
        rankName = await getRobloxGroupRank(robloxId, ROBLOX_GROUP_ID);
        if (rankName) {
          await syncRobloxRole(member, rankName);
        }
      }

      try {
        await instructionMsg.edit({ components: [] });
      } catch {}

      try {
        await dmChannel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("✅ You're verified!")
              .setColor(0x57f287)
              .setDescription(
                `Your Roblox account **${robloxUsername}** has been linked to your Discord.\n\n` +
                (rankName
                  ? `🎖️ Your group rank **${rankName}** has been synced as a Discord role.`
                  : `You're not in the Roblox group, so no rank role was assigned.`) +
                `\n\nYou can remove the code from your Roblox description now.`
              )
              .setTimestamp(),
          ],
        });
      } catch {}
    }
  }, SCAN_INTERVAL_MS);

  const verifyTimeout = setTimeout(async () => {
    cancelVerification(interaction.user.id);
    try {
      await instructionMsg.edit({ components: [] });
    } catch {}
    try {
      await dmChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("⏰ Verification timed out")
            .setColor(0xed4245)
            .setDescription(
              "We couldn't detect your code in time. Run `/verify` again whenever you're ready."
            ),
        ],
      });
    } catch {}
  }, VERIFY_TIMEOUT_MS);

  pending.set(interaction.user.id, {
    discordUserId: interaction.user.id,
    robloxUsername,
    code,
    interval: scanInterval,
    timeout: verifyTimeout,
  });
}
