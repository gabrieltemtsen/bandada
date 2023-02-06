import { id } from "@ethersproject/hash"
import {
    BadRequestException,
    forwardRef,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    UnauthorizedException
} from "@nestjs/common"
import { SchedulerRegistry, Timeout } from "@nestjs/schedule"
import { InjectRepository } from "@nestjs/typeorm"
import { Group as CachedGroup } from "@semaphore-protocol/group"
import { zkGroups } from "@zk-groups/contract-utils"
import { Repository } from "typeorm"
import { InvitesService } from "../invites/invites.service"
import { AddMemberDto } from "./dto/add-member.dto"
import { CreateGroupDto } from "./dto/create-group.dto"
import { UpdateGroupDto } from "./dto/update-group.dto"
import { Group } from "./entities/group.entity"
import { MerkleProof } from "./types"

@Injectable()
export class GroupsService {
    private cachedGroups: Map<string, CachedGroup>
    private updatedGroups: zkGroups.Group[]

    constructor(
        @InjectRepository(Group)
        private readonly groupRepository: Repository<Group>,
        @Inject(forwardRef(() => InvitesService))
        private readonly invitesService: InvitesService,
        private schedulerRegistry: SchedulerRegistry
    ) {
        ;(async () => {
            this.cachedGroups = new Map()
            this.updatedGroups = []

            const groups = await this.getAllGroups()

            /* istanbul ignore next */
            for (const group of groups) {
                const groupId = BigInt(id(group.name))
                const cachedGroup = new CachedGroup(groupId, group.treeDepth)

                cachedGroup.addMembers(group.members)

                this.cachedGroups.set(group.name, cachedGroup)
            }

            Logger.log(
                `GroupsService: ${groups.length} groups have been cached`
            )
        })()
    }

    /**
     * Creates a new group.
     * @param dto External parameters used to create a new group.
     * @param admin Admin username.
     * @returns Created group.
     */
    async createGroup(
        { name, description, treeDepth, tag }: CreateGroupDto,
        admin: string
    ): Promise<Group> {
        const group = this.groupRepository.create({
            name,
            description,
            treeDepth,
            tag,
            admin: admin,
            members: []
        })

        await this.groupRepository.save(group)

        const cachedGroup = new CachedGroup(treeDepth)

        this.cachedGroups.set(name, cachedGroup)

        Logger.log(`GroupsService: group '${name}' has been created`)

        return group
    }

    /**
     * Updates some parameters of the group.
     * @param dto External parameters used to update a group.
     * @param groupName Group name.
     * @param admin Admin username.
     * @returns Updated group.
     */
    async updateGroup(
        { description, treeDepth, tag }: UpdateGroupDto,
        groupName: string,
        admin: string
    ): Promise<Group> {
        const group = await this.getGroup(groupName)

        if (group.admin !== admin) {
            throw new UnauthorizedException(
                `You are not the admin of the group '${groupName}'`
            )
        }

        group.description = description
        group.treeDepth = treeDepth
        group.tag = tag

        await this.groupRepository.save(group)

        Logger.log(`GroupsService: group '${group.name}' has been updated`)

        return group
    }

    /**
     * If a member does not exist in the group, they is added.
     * @param dto Parameters used to add a group member.
     * @param groupName Group name.
     * @param member Member's identity commitment.
     * @returns Group data with added member.
     */
    async addMember(
        { inviteCode }: AddMemberDto,
        groupName: string,
        member: string
    ): Promise<Group> {
        if (this.isGroupMember(groupName, member)) {
            throw new BadRequestException(
                `Member '${member}' already exists in the group '${groupName}'`
            )
        }

        await this.invitesService.redeemInvite(inviteCode, groupName)

        const group = await this.getGroup(groupName)

        group.members.push(member)

        await this.groupRepository.save(group)

        const cachedGroup = this.cachedGroups.get(groupName)

        cachedGroup.addMember(member)

        Logger.log(
            `GroupsService: member '${member}' has been added to the group '${group.name}'`
        )

        this.updatedGroups.push({
            id: BigInt(id(group.name)),
            fingerprint: BigInt(cachedGroup.root)
        })

        if (this.schedulerRegistry.getTimeouts().length === 0) {
            this.updateContractGroups()
        }

        return group
    }

    /**
     * Returns a list of groups.
     * @returns List of existing groups.
     */
    async getAllGroups(): Promise<Group[]> {
        return await this.groupRepository.find()
    }

    /**
     * Returns a list of groups of a specific admin.
     * @param admin Admin username.
     * @returns List of admin's existing groups.
     */
    async getGroupsByAdmin(admin: string): Promise<Group[]> {
        return await this.groupRepository.findBy({ admin })
    }

    /**
     * Returns a specific group.
     * @param groupName Group name.
     * @returns Specific group.
     */
    async getGroup(groupName: string): Promise<Group> {
        const group = await this.groupRepository.findOneBy({
            name: groupName
        })

        if (!group) {
            throw new NotFoundException(`Group '${groupName}' does not exist`)
        }

        return group
    }

    /**
     * Checks if a member belongs to a group.
     * @param groupName Group name.
     * @param member Member's identity commitment.
     * @returns True or false.
     */
    isGroupMember(groupName: string, member: string): boolean {
        const cachedGroup = this.cachedGroups.get(groupName)

        return cachedGroup.indexOf(BigInt(member)) !== -1
    }

    /**
     * Generates a proof of membership.
     * @param groupName Group name.
     * @param member Member's identity commitment.
     * @returns Merkle proof.
     */
    generateMerkleProof(groupName: string, member: string): MerkleProof {
        if (!this.isGroupMember(groupName, member)) {
            throw new BadRequestException(
                `Member '${member}' does not exist in the group '${groupName}'`
            )
        }

        const cachedGroup = this.cachedGroups.get(groupName)
        const memberIndex = cachedGroup.indexOf(BigInt(member))

        return cachedGroup.generateMerkleProof(memberIndex)
    }

    /**
     * Updates the contract groups.
     */
    /* istanbul ignore next */
    @Timeout(60 * 1000) // 1 minute
    private async updateContractGroups() {
        if (this.updatedGroups.length > 0) {
            const tx = await zkGroups.updateGroups(this.updatedGroups)

            this.updatedGroups = []

            if (tx.status) {
                Logger.log(
                    `GroupsService: ${tx.events.length} ${
                        tx.events.length === 1 ? "group" : "groups"
                    } have been updated in the contract`
                )
            } else {
                Logger.error(`GroupsService: failed to update contract groups`)
            }
        }
    }
}
