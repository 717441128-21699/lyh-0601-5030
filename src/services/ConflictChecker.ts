import {
  ConflictCheckRequest,
  ConflictCheckResult,
  LeaveConflict,
  LeaveRequest,
  OvertimeRecord,
} from '../types';
import { WorkdayChecker } from './WorkdayChecker';
import {
  parseDateTime,
  getDatePart,
  generateDateRange,
} from '../utils/dateUtils';

export class ConflictChecker {
  private workdayChecker: WorkdayChecker;

  constructor(workdayChecker: WorkdayChecker) {
    this.workdayChecker = workdayChecker;
  }

  checkConflicts(request: ConflictCheckRequest): ConflictCheckResult {
    const conflicts: LeaveConflict[] = [];

    const overlapConflicts = this.checkLeaveOverlap(request);
    conflicts.push(...overlapConflicts);

    const nonWorkDayConflicts = this.checkNonWorkDayConflicts(request);
    conflicts.push(...nonWorkDayConflicts);

    return {
      hasConflict: conflicts.length > 0,
      conflicts,
    };
  }

  private checkLeaveOverlap(request: ConflictCheckRequest): LeaveConflict[] {
    const conflicts: LeaveConflict[] = [];
    const { startTime, endTime, existingLeaves, excludeRequestId } = request;

    for (const existing of existingLeaves) {
      if (existing.id === excludeRequestId) continue;
      if (existing.status === 'rejected' || existing.status === 'cancelled') continue;

      const overlap = this.calculateTimeOverlap(
        startTime,
        endTime,
        existing.startTime,
        existing.endTime
      );

      if (overlap > 0) {
        conflicts.push({
          type: 'leave_overlap',
          description: `与请假单 ${existing.id} 存在时间重叠（重叠约 ${overlap.toFixed(1)} 小时）`,
          conflictingRequestId: existing.id,
        });
      }
    }

    return conflicts;
  }

  private checkNonWorkDayConflicts(request: ConflictCheckRequest): LeaveConflict[] {
    const conflicts: LeaveConflict[] = [];
    const { startTime, endTime } = request;

    const startDate = getDatePart(startTime);
    const endDate = getDatePart(endTime);
    const dates = generateDateRange(startDate, endDate);

    for (const date of dates) {
      if (this.workdayChecker.isHoliday(date) && !this.workdayChecker.isMakeupWorkday(date)) {
        const holidayInfo = this.workdayChecker.getHolidayInfo(date);
        conflicts.push({
          type: 'non_work_day',
          description: `${date} 为节假日${holidayInfo ? `(${holidayInfo.name})` : ''}，无需请假`,
          date,
        });
      } else if (this.workdayChecker.isWeekend(date) && !this.workdayChecker.isMakeupWorkday(date)) {
        conflicts.push({
          type: 'non_work_day',
          description: `${date} 为周末，无需请假`,
          date,
        });
      }
    }

    return conflicts;
  }

  private calculateTimeOverlap(
    start1: string,
    end1: string,
    start2: string,
    end2: string
  ): number {
    const s1 = parseDateTime(start1).getTime();
    const e1 = parseDateTime(end1).getTime();
    const s2 = parseDateTime(start2).getTime();
    const e2 = parseDateTime(end2).getTime();

    const overlapStart = Math.max(s1, s2);
    const overlapEnd = Math.min(e1, e2);

    if (overlapStart >= overlapEnd) return 0;
    return (overlapEnd - overlapStart) / (1000 * 60 * 60);
  }

  checkOvertimeConflicts(
    employeeId: string,
    startTime: string,
    endTime: string,
    overtimes: OvertimeRecord[],
    excludeId?: string
  ): LeaveConflict[] {
    const conflicts: LeaveConflict[] = [];

    for (const ot of overtimes) {
      if (ot.id === excludeId) continue;
      if (!ot.approved) continue;

      const otStart = `${ot.date} ${ot.startTime}`;
      const otEnd = `${ot.date} ${ot.endTime}`;

      const overlap = this.calculateTimeOverlap(
        startTime,
        endTime,
        otStart,
        otEnd
      );

      if (overlap > 0) {
        conflicts.push({
          type: 'overtime_overlap',
          description: `与加班记录 ${ot.id} 存在时间重叠（重叠约 ${overlap.toFixed(1)} 小时）`,
          conflictingRequestId: ot.id,
          date: ot.date,
        });
      }
    }

    return conflicts;
  }

  hasAnyConflict(request: ConflictCheckRequest): boolean {
    const result = this.checkConflicts(request);
    return result.hasConflict;
  }
}
